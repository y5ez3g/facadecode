//! Typed operations and topics for JSON-RPC. Each type defines its name, documentation, arguments,
//! and results for the daemon, clients, and generated references.

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// A `call` operation, named `<thing>.<verb>`, with its argument and result types.
pub trait Operation {
    const NAME: &'static str;
    /// A description that starts with a verb.
    const DOC: &'static str;
    type Args: Serialize + DeserializeOwned + JsonSchema;
    type Result: Serialize + DeserializeOwned + JsonSchema;
}

/// A `watch` topic with its argument, snapshot, and change types.
pub trait Topic {
    const NAME: &'static str;
    /// A description of the topic and its changes.
    const DOC: &'static str;
    type Args: Serialize + DeserializeOwned + JsonSchema;
    type Snapshot: Serialize + DeserializeOwned + JsonSchema;
    type Change: Serialize + DeserializeOwned + JsonSchema;
}

/// Visits the protocol's operation list.
pub trait OperationVisitor {
    fn operation<O: Operation>(&mut self);
}

/// An empty success result: `{}`.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct EmptyResult {}
