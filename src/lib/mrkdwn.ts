/**
 * Convert GitHub-style markdown to Slack mrkdwn.
 *
 * Slack doesn't support ## headings or **double asterisks**.
 * This converts them to Slack equivalents.
 */
export function toSlackMrkdwn(text: string): string {
  return text
    // ## Heading → *Heading* (bold line)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    // **bold** → *bold*
    .replace(/\*\*(.+?)\*\*/g, "*$1*");
}
