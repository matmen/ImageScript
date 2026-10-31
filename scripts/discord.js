// posts a release's notes to a Discord channel through a webhook (release.yml), as an embed linking to the release:
// headings become bold lines (embeds don't render them), notes beyond the embed's 4096 characters end at a paragraph
// with a link to the rest, and mentions in the notes don't ping anyone. Without a webhook it does nothing
const { WEBHOOK, NAME, VERSION, URL, BODY = '' } = process.env;

if (!WEBHOOK) {
    console.log('no DISCORD_WEBHOOK secret, nothing posted');
    process.exit(0);
}

const LIMIT = 4096;
const more = `\n\n[Full release notes](${URL})`;
let text = BODY.replace(/\r\n/g, '\n').replace(/^#{1,6}\s+(.+)$/gm, '**$1**').trim();
if (text.length > LIMIT) {
    const cut = text.lastIndexOf('\n\n', LIMIT - more.length);
    text = text.slice(0, cut > 0 ? cut : LIMIT - more.length) + more;
}

const message = {
    username: 'ImageScript',
    allowed_mentions: { parse: [] },
    embeds: [{
        title: `ImageScript ${NAME || VERSION}`,
        url: URL,
        description: text,
        color: 0x3178c6,
        footer: { text: `npm install imagescript@${VERSION}` }
    }]
};

(async () => {
    const response = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message)
    });
    if (!response.ok) {
        console.error(`Discord answered ${response.status}: ${await response.text()}`);
        process.exit(1);
    }
    console.log('posted to Discord');
})();
