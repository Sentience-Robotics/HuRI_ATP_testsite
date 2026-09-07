# Terraform root for the HuRI website demo (OIDC relying party + Authelia IdP).
#
# This is a SEPARATE root module from the HuRI cluster Terraform
# (HuRI/deploy/examples/cloud). HuRI is the agnostic Ray/MLOps framework and owns
# the GKE cluster, Ray Serve app, Qdrant, LiteLLM, and the website image's
# Artifact Registry (the "GCR"). This module owns only the website-specific
# stack: the website backend Deployment/Service/Ingress and the Authelia identity
# provider that authenticates it. Apply it AFTER the HuRI cluster exists — it
# reads the cluster via data sources rather than creating it.

terraform {
  required_version = ">= 1.3"

  # Remote state in GCS (same bucket as the HuRI cluster module, different
  # prefix). The bucket must exist before init and is passed at init time:
  #   terraform init -backend-config="bucket=<your-tf-state-bucket>"
  # See HuRI/gcp_steps.md §0.
  backend "gcs" {
    prefix = "huri-website"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.20"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Credentials + endpoint for the EXISTING HuRI cluster (created by the HuRI
# Terraform). We only read it here; we never manage the cluster from this module.
data "google_client_config" "default" {}

data "google_container_cluster" "primary" {
  name     = var.cluster_name
  location = var.region
}

provider "kubernetes" {
  host                   = "https://${data.google_container_cluster.primary.endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(data.google_container_cluster.primary.master_auth[0].cluster_ca_certificate)
}
