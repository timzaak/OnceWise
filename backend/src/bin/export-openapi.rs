// Prints the OpenAPI 3 document (`GET /api/openapi.json`) to stdout without
// touching the database. docs-web consumes the output as its `openapi.json`
// (see docs-web's `npm run generate-api-docs`); the document is fixed at
// compile time, so no server has to run for the docs build.

use utoipa::OpenApi;

fn main() -> anyhow::Result<()> {
    let doc = oncewise_ai_sync::openapi::ApiDoc::openapi();
    println!("{}", serde_json::to_string_pretty(&doc)?);
    Ok(())
}
