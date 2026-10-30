#[test]
fn verify_roundtrip() {
    let secret = "owhsec_x";
    let body = br#"{"event":"email.delivered"}"#;
    let now = 1_784_764_800;
    let sig = postwave::webhook::compute_header(secret, now, body);
    assert!(postwave::webhook::verify_at(&sig, secret, body, now, 300));
    assert!(!postwave::webhook::verify_at(&sig, "wrong", body, now, 300));
    assert!(!postwave::webhook::verify_at("garbage", secret, body, now, 300));
    assert!(!postwave::webhook::verify_at(&sig, secret, body, now + 301, 300));
    let rotating = format!(
        "t={now},v1={},v1={}",
        "0".repeat(64),
        postwave::webhook::compute(secret, now, body)
    );
    assert!(postwave::webhook::verify_at(&rotating, secret, body, now, 300));
    assert!(!postwave::webhook::verify_at(
        &format!("{sig},t={now}"),
        secret,
        body,
        now,
        300
    ));
}

#[test]
fn send_email_serializes() {
    // Build an input and confirm it serializes to the expected wire shape.
    let input = postwave::SendEmail {
        from: Some("a@b.com".into()),
        to: vec!["c@d.com".into()],
        subject: "Hi".into(),
        html: Some("<b>x</b>".into()),
        ..Default::default()
    };
    let v = serde_json::to_value(&input).unwrap();
    assert_eq!(v["to"][0], "c@d.com");
    assert_eq!(v["html"], "<b>x</b>");
    assert!(v.get("cc").is_none(), "empty cc should be omitted");
}
