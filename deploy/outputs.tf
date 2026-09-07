output "authelia_url" {
  value       = "https://${var.auth_host}"
  description = "Public Authelia / OIDC issuer URL (the website's OIDC_ISSUER)."
}

output "website_url" {
  value       = var.website_origin
  description = "Public website backend URL (OIDC relying party; serves /auth/* and /ws)."
}

output "website_image" {
  value       = local.website_image
  description = "Full Artifact Registry image reference the website Deployment pulls."
}

output "ingress_ip" {
  value       = google_compute_global_address.ingress.address
  description = "Reserved static IP shared by the website + Authelia LB. Point BOTH the website_origin and auth_host DNS A records here BEFORE apply (also required for the managed cert to provision)."
}
