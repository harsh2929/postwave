use crate::emails::urlencode;
use crate::{Client, Error};
use serde_json::Value;

/// The subscribers resource (CRUD). Returns raw JSON values for flexibility.
pub struct Subscribers<'a> {
    pub(crate) client: &'a Client,
}

impl Subscribers<'_> {
    pub fn list(&self, query: &[(&str, &str)]) -> Result<Value, Error> {
        let mut path = String::from("/api/v1/subscribers");
        if !query.is_empty() {
            let qs: Vec<String> = query
                .iter()
                .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
                .collect();
            path.push('?');
            path.push_str(&qs.join("&"));
        }
        self.client.request("GET", &path, None)
    }

    pub fn get(&self, id: &str) -> Result<Value, Error> {
        self.client
            .request("GET", &format!("/api/v1/subscribers/{}", urlencode(id)), None)
    }

    pub fn create(&self, attributes: Value) -> Result<Value, Error> {
        self.client.request("POST", "/api/v1/subscribers", Some(attributes))
    }

    pub fn update(&self, id: &str, attributes: Value) -> Result<Value, Error> {
        self.client.request(
            "PATCH",
            &format!("/api/v1/subscribers/{}", urlencode(id)),
            Some(attributes),
        )
    }

    pub fn delete(&self, id: &str) -> Result<Value, Error> {
        self.client
            .request("DELETE", &format!("/api/v1/subscribers/{}", urlencode(id)), None)
    }
}
