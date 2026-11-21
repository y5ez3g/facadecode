//! API version sets and negotiation shared by both endpoints.

#![allow(
    clippy::result_large_err,
    reason = "The wire API returns the structured error by value"
)]

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::Value;

use super::frame::ErrorBody;

pub type ApiVersion = std::num::NonZeroU64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(transparent)]
pub struct ApiVersions(#[schemars(length(min = 1))] Vec<ApiVersion>);

impl ApiVersions {
    pub fn new(mut versions: Vec<ApiVersion>) -> Option<Self> {
        if versions.is_empty() {
            return None;
        }
        versions.sort_unstable();
        versions.dedup();
        Some(Self(versions))
    }

    pub fn as_slice(&self) -> &[ApiVersion] {
        &self.0
    }

    pub fn contains(&self, version: ApiVersion) -> bool {
        self.0.binary_search(&version).is_ok()
    }
}

impl<'de> Deserialize<'de> for ApiVersions {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(Vec::deserialize(deserializer)?)
            .ok_or_else(|| de::Error::custom("API versions must be nonempty"))
    }
}

pub fn highest_common(offered: &ApiVersions, supported: &[ApiVersion]) -> Option<ApiVersion> {
    supported
        .iter()
        .copied()
        .filter(|&version| offered.contains(version))
        .max()
}

pub(super) fn decode_hello_offer(params: &Value) -> Result<ApiVersions, ErrorBody> {
    params
        .get("api_versions")
        .and_then(|value| ApiVersions::deserialize(value).ok())
        .ok_or_else(|| {
            ErrorBody::invalid_argument(
                "Provide hello.params.api_versions as a non-empty array of positive integers. Use a Facade API v1 build.",
            )
        })
}
