# ---------------------------------------------------------------------------
# Cluster locator — points this module at the EXISTING HuRI GKE cluster.
# These must match the values used by the HuRI Terraform.
# ---------------------------------------------------------------------------

variable "project_id" {
  description = "GCP project ID hosting the HuRI cluster and the website image registry."
  type        = string
}

variable "region" {
  description = "GCP region of the HuRI GKE cluster."
  type        = string
  default     = "us-central1"
}

variable "cluster_name" {
  description = "Name of the existing HuRI GKE cluster to deploy the website into."
  type        = string
  default     = "huri-ray-cluster"
}

variable "huri_namespace" {
  description = "Kubernetes namespace the HuRI app runs in (created by the HuRI Terraform). The website Deployment is placed here so it can reach huri-serve-svc."
  type        = string
  default     = "huri"
}

variable "cpu_node_pool" {
  description = "GKE node pool the CPU-only website + Authelia pods are pinned to (via the cloud.google.com/gke-nodepool label), keeping them off the GPU pool. Must be an untainted pool in the cluster."
  type        = string
  default     = "system-pool"
}

# ---------------------------------------------------------------------------
# Authelia / OIDC
# ---------------------------------------------------------------------------

variable "auth_host" {
  description = "Public hostname for Authelia (e.g. auth.huri.pommier.dev)."
  type        = string
}

variable "cookie_domain" {
  description = "Parent domain the Authelia session cookie is scoped to (e.g. pommier.dev)."
  type        = string
}

variable "website_origin" {
  description = "Origin of the HuRI website (OIDC relying party), used to build redirect URIs (e.g. https://app.huri.pommier.dev)."
  type        = string
}

# NOTE: All secret values (Authelia session/JWT/HMAC/storage keys, the OIDC
# issuer private key, client secret + its hash, the demo user's password hash,
# and the website session secret) are NO LONGER Terraform variables. They are
# read from GCP Secret Manager in secrets.tf. Populate them out of band per the
# README before applying.

variable "oidc_client_id" {
  description = "OIDC client id registered for the HuRI website. Used by both Authelia (the IdP) and the website (the relying party)."
  type        = string
  default     = "huri-website"
}

variable "authelia_users" {
  description = <<-EOT
    Authelia file-backend demo users. Each entry's `password_secret` is the GCP
    Secret Manager secret id holding that user's argon2 password hash — create
    those secrets out of band (README §1) before applying. Every id listed here is
    read automatically by secrets.tf, so adding a user is: add an entry + create
    its secret. Each user gets a distinct, stable OIDC `sub`, hence a distinct
    HuRI RAG identity.
  EOT
  type = list(object({
    username        = string
    display         = string
    email           = string
    password_secret = string
  }))
  default = [
    { username = "demo", display = "Demo User", email = "demo@example.com", password_secret = "authelia_user_password_hash" },
    { username = "demo2", display = "Demo User 2", email = "demo2@example.com", password_secret = "authelia_user2_password_hash" },
    { username = "demo3", display = "Demo User 3", email = "demo3@example.com", password_secret = "authelia_user3_password_hash" },
  ]
}

# ---------------------------------------------------------------------------
# Website backend (OIDC relying party + HuRI websocket bridge)
# ---------------------------------------------------------------------------

variable "huri_ws_url" {
  description = "In-cluster HuRI Ray Serve websocket session endpoint the website connects to (HURI_URL). KubeRay names the Serve service <release>-serve-svc."
  type        = string
  default     = "ws://huri-serve-svc.huri.svc.cluster.local:8000/session"
}

variable "frontend_url" {
  description = "Origin where the SPA is served (FRONTEND_URL). Empty = same origin as website_origin."
  type        = string
  default     = ""
}

variable "website_cookie_samesite" {
  description = "SameSite policy for the session cookie. 'lax' for a same-site frontend; 'none' (with HTTPS) for a cross-site frontend."
  type        = string
  default     = "lax"
}

variable "magic_link_max_age" {
  description = "Seconds a passwordless magic-link QR token stays valid before /auth/magic rejects it (MAGIC_LINK_MAX_AGE). 0 = never expires, suitable for a QR you print once and reuse at a demo booth. Set a positive value to time-box the link."
  type        = number
  default     = 0
}

# ---------------------------------------------------------------------------
# Reserved static IP — one shared global IP fronting both public hosts
# (website_origin and auth_host) via a single Ingress. Reserving it lets you
# create the DNS A records (and let the managed cert provision) before
# `terraform apply`. Created in website.tf; surfaced as the `ingress_ip` output.
# ---------------------------------------------------------------------------

variable "ingress_static_ip_name" {
  description = "Name of the reserved global static IP shared by the website + Authelia Ingress LB."
  type        = string
  default     = "huri-ingress-ip"
}

# ---------------------------------------------------------------------------
# Website image — built/pushed out of band into HuRI's Artifact Registry (the
# "GCR", which the HuRI Terraform owns). These reconstruct the image reference
# the Deployment pulls; this module does NOT manage the registry itself.
# ---------------------------------------------------------------------------

variable "website_image_location" {
  description = "Artifact Registry location (region) holding the website image, e.g. us-central1. Must match the HuRI registry."
  type        = string
  default     = "us-central1"
}

variable "website_image_repo" {
  description = "Artifact Registry repository id holding the website image. Must match the HuRI registry."
  type        = string
  default     = "huri"
}

variable "website_image_name" {
  description = "Website image name within the repo."
  type        = string
  default     = "huri-website"
}

variable "website_image_tag" {
  description = "Website image tag to deploy."
  type        = string
  default     = "latest"
}
