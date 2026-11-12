# swoosh.pay Cloudflare deployment

- Map the Node HTTP server to Workers' Node HTTP adapter. Keep the same HTTP routes, provider callbacks, and rendered forms.
- Map local SQLite tables to an isolated D1 database using the same schema and SQL constraints. The local Node entry point continues to use SQLite. The workspace has no local database to import.
- Keep payment, invite, session, and webhook records durable. Await each dependent D1 statement. Route reads to the primary to see writes made by earlier requests.
- Keep the PayPal Sandbox settings in Worker secrets. The Cloudflare deployment owns its public origin and uses distinct OAuth and webhook registrations for that origin.
- Verify the existing HTTP tests locally, apply the D1 migration, and check the deployed homepage, CSS, provider callback routes, and database schema.
