use serde::Serialize;

pub type NativeResult<T> = Result<T, NativeError>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: String,
    pub args: Vec<String>,
    pub fallback: String,
    #[serde(skip_serializing_if = "is_false")]
    pub outcome_unknown: bool,
}

impl NativeError {
    pub fn new(code: &str, fallback: &str) -> Self {
        Self {
            code: code.to_owned(),
            args: Vec::new(),
            fallback: fallback.to_owned(),
            outcome_unknown: false,
        }
    }

    pub fn outcome_unknown(mut self) -> Self {
        self.outcome_unknown = true;
        self
    }

    pub fn with_args(code: &str, fallback: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            code: code.to_owned(),
            args,
            fallback: fallback.into(),
            outcome_unknown: false,
        }
    }

    pub fn detail(code: &str, fallback: &str, detail: impl std::fmt::Display) -> Self {
        let detail: String = detail
            .to_string()
            .chars()
            .take(1024)
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .collect();
        let message = if detail.is_empty() {
            fallback.to_owned()
        } else {
            format!("{fallback} Technical details: {detail}")
        };
        Self::with_args(
            code,
            message,
            (!detail.is_empty()).then_some(detail).into_iter().collect(),
        )
    }
}

fn is_false(value: &bool) -> bool {
    !value
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.fallback)
    }
}

impl std::error::Error for NativeError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_a_stable_webview_contract() {
        let error = NativeError::new("RCON_TIMEOUT", "RCON timed out.").outcome_unknown();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "code": "RCON_TIMEOUT",
                "args": [],
                "fallback": "RCON timed out.",
                "outcomeUnknown": true
            })
        );
    }

    #[test]
    fn bounds_and_sanitizes_technical_details() {
        let error = NativeError::detail(
            "CREDENTIAL_READ_FAILED",
            "Could not read Windows credentials.",
            format!("vault\n{}", "x".repeat(2048)),
        );
        assert_eq!(error.args.len(), 1);
        assert!(!error.args[0].contains('\n'));
        assert_eq!(error.args[0].chars().count(), 1024);
        assert!(error
            .fallback
            .starts_with("Could not read Windows credentials."));
    }
}
