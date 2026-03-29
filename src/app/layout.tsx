export const metadata = {
  title: "Battle Mage",
  description:
    "Slack agent with Claude AI intelligence and GitHub repo access",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
