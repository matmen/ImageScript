const {Image} = require('..');
const fs = require('fs').promises;

(async () => {
    const [backgroundSVG, avatarBinary, badges, font] = await Promise.all([
        fs.readFile('./tests/svgs/background.svg').then(b => b.toString()),
        fs.readFile('./tests/targets/external.png'),
        Promise.all(
            [
                'crown', 'potato', 'mask', 'microbe', 'petri_dish', 'thermometer', 'cigarette'
            ].map(
                x => fs.readFile(`./tests/svgs/${x}.svg`)
                    .then(b => b.toString()))
        ),
        fs.readFile('./tests/fonts/carbon phyber.ttf')
    ]);

    const image = new Image(1000, 700);

    const backgroundPattern = await Image.renderSVG(backgroundSVG);
    for (let xOffset = 0; xOffset < image.width; xOffset += backgroundPattern.width) {
        for (let yOffset = 0; yOffset < image.height; yOffset += backgroundPattern.height) {
            image.composite(backgroundPattern, xOffset, yOffset);
        }
    }

    const avatarBG = new Image(200 + 16, 200 + 16);
    const avatarGradient = Image.gradient({0: 0x00ffffff, 1: 0x0080ffff});
    avatarBG.fill((x, y) => avatarGradient((x + y) / (avatarBG.width + avatarBG.height)));
    image.composite(avatarBG.cropCircle(), 0.05 * image.width, 0.05 * image.height);

    const avatar = await Image.decode(avatarBinary);
    image.composite(avatar.resize(200, 200).cropCircle(), 0.05 * image.width + 8, 0.05 * image.height + 8);

    const username = await Image.renderText(font, 64, 'matmen', 0xffffffff);
    image.composite(username, 0.3 * image.width, 0.05 * image.height);

    image.drawBox(0.3 * image.width, 0.05 * image.height + username.height, username.width, 3, 0x808080ff);

    const discriminator = await Image.renderText(font, 48, '#9984', 0xd0d0d0ff);
    image.composite(discriminator, 0.3 * image.width, 0.05 * image.height + username.height);

    // Global XP
    {
        const xpBarBackground = new Image(0.9 * image.width, 0.05 * image.height);
        xpBarBackground.fill(0xa0a0a0ff);
        image.composite(xpBarBackground.roundCorners(16), 0.05 * image.width, 0.5 * image.height);

        const xpBar = new Image(69 / 420 * xpBarBackground.width, 0.05 * image.height);
        const xpGradient = Image.gradient({0: 0x0080ffff, .8: 0x00ffffff, 1: 0x00ff80ff});
        xpBar.fill(x => xpGradient(x / xpBarBackground.width));
        image.composite(xpBar.roundCorners(16), 0.05 * image.width, 0.5 * image.height);

        const xpText = await Image.renderText(font, 32, '69/420', 0xff);
        image.composite(xpText, 0.05 * image.width + xpBarBackground.width / 2 - xpText.width / 2, 0.5 * image.height + xpBarBackground.height / 2 - xpText.height / 2);

        const levelText = await Image.renderText(font, 32, 'Level 3', 0xffffffff);
        image.composite(levelText, 0.05 * image.width + xpBarBackground.width - levelText.width, 0.5 * image.height - levelText.height);

        const xpKindText = await Image.renderText(font, 32, 'Global XP', 0xffffffff);
        image.composite(xpKindText, 0.05 * image.width, 0.5 * image.height - levelText.height);
    }

    // Server XP
    {
        const xpBarBackground = new Image(0.9 * image.width, 0.05 * image.height);
        xpBarBackground.fill(0xa0a0a0ff);
        image.composite(xpBarBackground.roundCorners(16), 0.05 * image.width, 0.65 * image.height);

        const xpBar = new Image(75 / 100 * xpBarBackground.width, 0.05 * image.height);
        const xpGradient = Image.gradient({0: 0x0080ffff, .8: 0x00ffffff, 1: 0x00ff80ff});
        xpBar.fill(x => xpGradient(x / xpBarBackground.width));
        image.composite(xpBar.roundCorners(16), 0.05 * image.width, 0.65 * image.height);

        const xpText = await Image.renderText(font, 32, '75/100', 0xff);
        image.composite(xpText, 0.05 * image.width + xpBarBackground.width / 2 - xpText.width / 2, 0.65 * image.height + xpBarBackground.height / 2 - xpText.height / 2);

        const levelText = await Image.renderText(font, 32, 'Level 1', 0xffffffff);
        image.composite(levelText, 0.05 * image.width + xpBarBackground.width - levelText.width, 0.65 * image.height - levelText.height);

        const xpKindText = await Image.renderText(font, 32, 'Server XP', 0xffffffff);
        image.composite(xpKindText, 0.05 * image.width, 0.65 * image.height - levelText.height);
    }

    const badgeBackground = new Image(...Array(2).fill(Math.sqrt(64 ** 2 * 2)));
    badgeBackground.fill(0xa0a0a080);
    badgeBackground.cropCircle();
    for (let i = 0; i < badges.length; i++) {
        image.composite(badgeBackground, 0.05 * image.width + 0.9 * image.width / badges.length * i, 0.8 * image.height);

        const badge = await Image.renderSVG(badges[i], 64, Image.SVG_MODE_WIDTH);
        if (i >= 3)
            badge.saturation(0);

        image.composite(
            badge,
            0.05 * image.width + 0.9 * image.width / badges.length * i + (badgeBackground.width - badge.width) / 2,
            0.8 * image.height + (badgeBackground.height - badge.height) / 2
        );
    }

    image.roundCorners(32);

    const encoded = await image.encode();

    if (!(await fs.readFile('./tests/targets/readme.png')).equals(Buffer.from(encoded)))
        process.exit(1);
})();