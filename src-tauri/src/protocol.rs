use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Debug, Clone)]
pub struct Request {
    pub id: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<ErrorBody>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Notification {
    pub event: String,
    #[serde(default)]
    pub params: Value,
}
