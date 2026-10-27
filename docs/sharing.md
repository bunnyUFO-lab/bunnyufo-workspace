# Sharing your version

Share only the examples and instructions you mean to publish. An empty MCP configuration does
not hide a token pasted into a report, so review the actual files you are sharing.

Keep `.env`, `.buw/`, agent login files and settings, raw generation receipts and private
inbox material local. The supplied `.gitignore` covers the common runtime paths, agent
configuration folders and deployed skills. It cannot recognize private text you put in an ordinary Markdown file.

Remove personal project names, private links, hostnames, message drafts and account details
from cards and docs before sharing. Review media as well as text. Keep third-party licenses and
source attribution.

Skills are not shared from here: each one belongs to an APM package, and this repository keeps
no copies. Point people at the package ([skills](skills.md) lists all three). A workflow a skill
depends on may still live in `knowledge/`, `processes/` or `scripts/`; share those deliberately.

Before a release, run `npm run lint`, `npm test`, `npm run test:template` and `npm run build`,
then `npm run test:preview`, which builds its own card and exercises the browser preview.
Inspect the staged file list before you push.
