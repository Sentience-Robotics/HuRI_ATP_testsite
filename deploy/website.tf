# HuRI website backend — the public-facing OIDC relying party and browser<->HuRI
# websocket bridge (backend/main.py). It completes the Authelia login, pins the
# OIDC `sub` as the HuRI session user_id / RAG partition key, and relays
# audio/motion to the in-cluster Ray Serve app at huri-serve-svc:8000.

locals {
  # Ingress host derived from the website origin (e.g. app.huri.example.com).
  website_host = replace(replace(var.website_origin, "https://", ""), "http://", "")
  # FRONTEND_URL defaults to the website origin (single-origin deployment).
  website_frontend_url = var.frontend_url != "" ? var.frontend_url : var.website_origin

  # Full image reference, e.g. us-central1-docker.pkg.dev/my-proj/huri/huri-website:latest.
  # The registry itself is owned by the HuRI Terraform; we only reference the image.
  website_image = format(
    "%s-docker.pkg.dev/%s/%s/%s:%s",
    var.website_image_location,
    var.project_id,
    var.website_image_repo,
    var.website_image_name,
    var.website_image_tag,
  )
}

# Signing key for the session cookie + plaintext OIDC client secret. Both are
# secrets (the cookie carries the authenticated identity), so never a ConfigMap.
resource "kubernetes_secret_v1" "website" {
  metadata {
    name      = "website-secrets"
    namespace = var.huri_namespace
  }
  data = {
    SESSION_SECRET     = local.secrets["website_session_secret"]
    OIDC_CLIENT_SECRET = local.secrets["oidc_client_secret"]
    # Signs the passwordless magic-link QR tokens redeemed at /auth/magic. Unset
    # would disable the route; it is required (secrets.tf reads it) so demos have
    # a stable signing key. Mint a QR with backend/tools/make_magic_qr.py.
    MAGIC_LINK_SECRET = local.secrets["magic_link_secret"]
  }
}

resource "kubernetes_deployment_v1" "website" {
  metadata {
    name      = "website"
    namespace = var.huri_namespace
    labels    = { app = "website" }
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "website" }
    }
    template {
      metadata {
        labels      = { app = "website" }
        annotations = { "secret/checksum" = sha256(jsonencode(kubernetes_secret_v1.website.data)) }
      }
      spec {
        # CPU-only bridge — keep it on the CPU node pool, off the GPU nodes.
        # GKE nodes carry cloud.google.com/gke-nodepool, not the kubeadm
        # control-plane label; the GPU pool is additionally taint-guarded.
        node_selector = {
          "cloud.google.com/gke-nodepool" = var.cpu_node_pool
        }

        container {
          name  = "website"
          image = local.website_image

          port {
            container_port = 8080
          }

          # Authelia is the OIDC issuer; pointing OIDC_ISSUER at it (plus the
          # client id/secret below) is what lets the backend mint the per-user
          # `sub` it pins as the HuRI user_id. Without this the backend rejects
          # every websocket under REQUIRE_AUTH=1.
          env {
            name  = "OIDC_ISSUER"
            value = "https://${var.auth_host}"
          }
          env {
            name  = "OIDC_CLIENT_ID"
            value = var.oidc_client_id
          }
          # Pin the redirect URI so it survives TLS-terminating proxies (don't
          # let Starlette's url_for() guess http:// behind the LB).
          env {
            name  = "OIDC_REDIRECT_URI"
            value = "${var.website_origin}/auth/callback"
          }
          env {
            name  = "FRONTEND_URL"
            value = local.website_frontend_url
          }
          env {
            name  = "HURI_URL"
            value = var.huri_ws_url
          }
          env {
            name  = "REQUIRE_AUTH"
            value = "1"
          }
          # Served over HTTPS behind the GCE LB → Secure cookie.
          env {
            name  = "COOKIE_SECURE"
            value = "1"
          }
          env {
            name  = "COOKIE_SAMESITE"
            value = var.website_cookie_samesite
          }
          # Seconds a magic-link QR token stays valid; 0 = never expires (a QR
          # you print once and reuse). See var.magic_link_max_age.
          env {
            name  = "MAGIC_LINK_MAX_AGE"
            value = tostring(var.magic_link_max_age)
          }
          env_from {
            secret_ref {
              name = kubernetes_secret_v1.website.metadata[0].name
            }
          }

          resources {
            requests = { cpu = "100m", memory = "256Mi" }
            limits   = { cpu = "1", memory = "1Gi" }
          }

          readiness_probe {
            http_get {
              path = "/auth/me"
              port = 8080
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }
        }
      }
    }
  }
}

# Raise the GCE LB backend timeout well above the 30s default — /ws is a
# long-lived websocket and would otherwise be torn down mid-session.
resource "kubernetes_manifest" "website_backendconfig" {
  manifest = {
    apiVersion = "cloud.google.com/v1"
    kind       = "BackendConfig"
    metadata = {
      name      = "website-backendconfig"
      namespace = var.huri_namespace
    }
    spec = {
      timeoutSec = 3600
    }
  }
}

resource "kubernetes_service_v1" "website" {
  metadata {
    name      = "website"
    namespace = var.huri_namespace
    annotations = {
      # NEG so the GCE Ingress LB targets the pods directly.
      "cloud.google.com/neg"            = jsonencode({ ingress = true })
      "cloud.google.com/backend-config" = jsonencode({ default = "website-backendconfig" })
    }
  }
  spec {
    selector = { app = "website" }
    port {
      port        = 80
      target_port = 8080
    }
    type = "ClusterIP"
  }

  depends_on = [kubernetes_manifest.website_backendconfig]
}

# One reserved static global IP fronting BOTH public hosts. A Kubernetes Ingress
# can only route to Services in its own namespace, so sharing a single LB/IP
# requires Authelia to live in this same (huri) namespace — it does (authelia.tf)
# — and a single Ingress (below) with one host rule per service. Reserving the IP
# (instead of an ephemeral one) lets you create the DNS A records before
# `terraform apply`, which the Google-managed cert also requires: it only goes
# Active once each hostname already resolves to this LB IP. Output as `ingress_ip`.
resource "google_compute_global_address" "ingress" {
  name = var.ingress_static_ip_name
}

# One GKE-managed TLS certificate covering both public hostnames.
resource "kubernetes_manifest" "ingress_cert" {
  manifest = {
    apiVersion = "networking.gke.io/v1"
    kind       = "ManagedCertificate"
    metadata = {
      name      = "huri-ingress-cert"
      namespace = var.huri_namespace
    }
    spec = {
      domains = [local.website_host, var.auth_host]
    }
  }
}

# Single GCE Ingress / load balancer serving the website (${website_origin}) and
# Authelia (https://${auth_host}) on one shared IP, routed by host.
resource "kubernetes_ingress_v1" "ingress" {
  metadata {
    name      = "huri-ingress"
    namespace = var.huri_namespace
    annotations = {
      "kubernetes.io/ingress.class"            = "gce"
      "networking.gke.io/managed-certificates" = "huri-ingress-cert"
      # Pin the LB to the reserved IP so DNS (and the managed cert) can point
      # here before apply.
      "kubernetes.io/ingress.global-static-ip-name" = google_compute_global_address.ingress.name
    }
  }
  spec {
    rule {
      host = local.website_host
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend {
            service {
              name = kubernetes_service_v1.website.metadata[0].name
              port {
                number = 80
              }
            }
          }
        }
      }
    }
    rule {
      host = var.auth_host
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend {
            service {
              name = kubernetes_service_v1.authelia.metadata[0].name
              port {
                number = 80
              }
            }
          }
        }
      }
    }
  }

  depends_on = [kubernetes_manifest.ingress_cert]
}
