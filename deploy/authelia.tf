# Authelia — the OIDC identity provider for the HuRI website.
#
# Authelia exists solely to authenticate the website's users: HuRI itself never
# talks to it. It authenticates users and issues a stable, opaque per-user `sub`
# over OIDC; the website backend (the relying party, in website.tf) turns that
# `sub` into the HuRI session `user_id` / RAG `_user_id`. Without it, the backend
# runs under REQUIRE_AUTH=1 with no issuer and rejects every websocket — so this
# IdP is part of the website demo, not the agnostic HuRI framework.
#
# Deployed as raw Kubernetes manifests (rather than the Helm chart) so the config
# is fully explicit and not tied to the chart's version-specific values schema.

# Authelia runs in the same (huri) namespace as the website so a single Ingress /
# load balancer can route to both on one shared IP — a Kubernetes Ingress can
# only target Services in its own namespace. The shared Ingress, cert and static
# IP live in website.tf.

locals {
  # Render the jwks block in Terraform so the PEM stays correctly indented under
  # the YAML `key: |` block scalar regardless of how the key is formatted.
  authelia_jwks_block = join("\n", concat(
    ["    jwks:", "      - key: |"],
    [for line in split("\n", trimspace(local.secrets["oidc_issuer_private_key"])) : "          ${line}"],
  ))

  authelia_configuration = templatefile("${path.module}/authelia-config.yaml", {
    session_secret          = local.secrets["authelia_session_secret"]
    storage_encryption_key  = local.secrets["authelia_storage_encryption_key"]
    jwt_secret              = local.secrets["authelia_jwt_secret"]
    oidc_hmac_secret        = local.secrets["oidc_hmac_secret"]
    oidc_jwks_block         = local.authelia_jwks_block
    oidc_client_id          = var.oidc_client_id
    oidc_client_secret_hash = local.secrets["oidc_client_secret_hash"]
    auth_host               = var.auth_host
    cookie_domain           = var.cookie_domain
    website_origin          = var.website_origin
  })

  # Resolve each user's argon2 hash from its Secret Manager secret, then render
  # the file-backend database over the whole list.
  authelia_user_entries = [for u in var.authelia_users : {
    username = u.username
    display  = u.display
    email    = u.email
    password = local.secrets[u.password_secret]
  }]

  authelia_users = templatefile("${path.module}/users_database.yml", {
    users = local.authelia_user_entries
  })
}

# The rendered config + user DB carry real secrets and the OIDC private key, so
# they live in a Secret (not a ConfigMap).
resource "kubernetes_secret_v1" "authelia_config" {
  metadata {
    name      = "authelia-config"
    namespace = var.huri_namespace
  }
  data = {
    "configuration.yml"  = local.authelia_configuration
    "users_database.yml" = local.authelia_users
  }
}

# Persistent volume for the SQLite store and the filesystem notifier.
resource "kubernetes_persistent_volume_claim_v1" "authelia_data" {
  metadata {
    name      = "authelia-data"
    namespace = var.huri_namespace
  }
  # standard-rwo is WaitForFirstConsumer: the PV is only provisioned once a pod
  # mounts the claim. Terraform creates the Deployment after this PVC, so waiting
  # for Bound here would deadlock (and time out). Let it bind when the pod lands.
  wait_until_bound = false
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "standard-rwo"
    resources {
      requests = { storage = "1Gi" }
    }
  }
}

resource "kubernetes_deployment_v1" "authelia" {
  metadata {
    name      = "authelia"
    namespace = var.huri_namespace
    labels    = { app = "authelia" }
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "authelia" }
    }
    # SQLite on RWO disk — never run two writers at once.
    strategy {
      type = "Recreate"
    }
    template {
      metadata {
        labels      = { app = "authelia" }
        # Hash both the config and the user DB so editing either (e.g. adding a
        # user) rolls the pod instead of silently drifting from the mounted Secret.
        annotations = { "config/checksum" = sha256("${local.authelia_configuration}${local.authelia_users}") }
      }
      spec {
        # The Service is named "authelia", so Kubernetes injects legacy
        # Docker-link env vars (AUTHELIA_PORT=tcp://<ip>:80, AUTHELIA_SERVICE_*)
        # into this pod. Authelia treats every AUTHELIA_* var as a config
        # override, so AUTHELIA_PORT maps to the deprecated `port` key and
        # fatally collides with server.address. Disable the injection.
        enable_service_links = false

        # CPU-only IdP — pin to the CPU node pool (GKE nodepool label), off the
        # taint-guarded GPU pool. The kubeadm control-plane label GKE lacks left
        # this Pending on the first apply.
        node_selector = {
          "cloud.google.com/gke-nodepool" = var.cpu_node_pool
        }
        container {
          name  = "authelia"
          image = "ghcr.io/authelia/authelia:4.39"
          args  = ["--config", "/config/configuration.yml"]

          port {
            container_port = 9091
          }

          volume_mount {
            name       = "config"
            mount_path = "/config"
            read_only  = true
          }
          volume_mount {
            name       = "data"
            mount_path = "/data"
          }

          resources {
            requests = { cpu = "100m", memory = "128Mi" }
            limits   = { cpu = "500m", memory = "512Mi" }
          }

          readiness_probe {
            http_get {
              path = "/api/health"
              port = 9091
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }
        }

        volume {
          name = "config"
          secret {
            secret_name = kubernetes_secret_v1.authelia_config.metadata[0].name
          }
        }
        volume {
          name = "data"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.authelia_data.metadata[0].name
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "authelia" {
  metadata {
    name      = "authelia"
    namespace = var.huri_namespace
    # NEG annotation so the GCE Ingress load balancer can target the pods.
    annotations = {
      "cloud.google.com/neg" = jsonencode({ ingress = true })
    }
  }
  spec {
    selector = { app = "authelia" }
    port {
      port        = 80
      target_port = 9091
    }
    type = "ClusterIP"
  }
}

# The TLS cert, static IP and Ingress that expose Authelia at https://${auth_host}
# are part of the shared single-IP Ingress in website.tf (host-routed alongside
# the website).
