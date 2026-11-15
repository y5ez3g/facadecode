//! Typed operations and topics for JSON-RPC. Each type defines its name, documentation, arguments,
//! and results for the daemon, clients, and generated references.

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// Visits the protocol's topic list.
pub trait TopicVisitor {
    fn topic<T: Topic>(&mut self);
}

/// Collects names from an operation or topic list.
pub fn collect_names(visit: impl FnOnce(&mut NameCollector)) -> Vec<String> {
    let mut names = NameCollector(Vec::new());
    visit(&mut names);
    names.0
}

pub struct NameCollector(Vec<String>);

impl OperationVisitor for NameCollector {
    fn operation<O: Operation>(&mut self) {
        self.0.push(O::NAME.to_string());
    }
}

impl TopicVisitor for NameCollector {
    fn topic<T: Topic>(&mut self) {
        self.0.push(T::NAME.to_string());
    }
}

/// Empty arguments: `{}`. May be omitted for topics that take no arguments.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct NoArgs {}

/// An empty success result: `{}`.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct EmptyResult {}

/// Parameters for `call`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CallParams {
    /// An operation listed in the `hello` result.
    pub op: String,
    /// Arguments for the named operation.
    #[serde(default)]
    pub args: Value,
}
