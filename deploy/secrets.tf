# Secrets come from GCP Secret Manager, not from variables or env vars. Create
# each secret and add a version OUT OF BAND before applying (see README §1);
# Terraform only *reads* the latest version here, so plaintext is never a
# Terraform input and never touches git.
#
# Caveat unchanged by Secret Manager: the decrypted values still land in
# Terraform state, so keep state in a secured remote backend (GCS, encrypted at
# rest with restricted IAM). The identity running Terraform needs
# roles/secretmanager.secretAccessor on these secrets.
locals {
  # Secret Manager secret IDs this module reads. Names match the Kubernetes
  # Secret keys they feed (see authelia.tf / website.tf).
  # The per-user password-hash secrets are contributed by var.authelia_users
  # (one secret id per user), so adding a user needs no change here.
  website_secret_ids = toset(concat([
    "authelia_session_secret",
    "authelia_storage_encryption_key",
    "authelia_jwt_secret",
    "oidc_hmac_secret",
    "oidc_issuer_private_key",
    "oidc_client_secret_hash",
    "website_session_secret",
    "oidc_client_secret",
    # Signs the passwordless magic-link QR tokens (/auth/magic). Keep it as
    # secret as the session secret — anyone who can forge a token is logged in.
    "magic_link_secret",
    ],
    [for u in var.authelia_users : u.password_secret],
  ))
}

data "google_secret_manager_secret_version" "website" {
  for_each = local.website_secret_ids
  secret   = each.key
  # version defaults to "latest".
}

locals {
  # Convenience map: secret id -> plaintext value.
  secrets = { for k, v in data.google_secret_manager_secret_version.website : k => v.secret_data }
}
