export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Battle Mage (@bm)</h1>
      <p>Slack agent with Claude AI intelligence and GitHub repo access.</p>
      <p>
        Invoke via <code>@bm</code> in Slack to ask questions about your
        codebase.
      </p>
      <hr style={{ margin: "1rem 0" }} />
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Webhook endpoint: <code>/api/slack</code>
      </p>
    </main>
  );
}
