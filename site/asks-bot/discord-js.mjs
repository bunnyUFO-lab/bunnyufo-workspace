// The only file that imports discord.js. It turns the bot's plain messages and clicks into discord.js
// calls and back, so bot.mjs never sees the library. A bot needs no privileged intents to send DMs and
// receive button clicks, so none is asked for; it sends no mentions.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, MessageFlags, Routes } from 'discord.js';

const payload = ({ content, components }) => {
  const rows = [];
  if (components?.options?.length) {
    rows.push(new ActionRowBuilder().addComponents(components.options.map(option => (
      new ButtonBuilder().setCustomId(option.customId).setLabel(option.label).setStyle(ButtonStyle.Primary)
    ))));
  }
  if (components?.link) {
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(components.link.label).setStyle(ButtonStyle.Link).setURL(components.link.url)));
  }
  return { content, components: rows.map(row => row.toJSON()), allowed_mentions: { parse: [] } };
};

export function createDiscordAdapter({ token }) {
  const client = new Client({ intents: [] });
  let handler = null;

  client.on(Events.InteractionCreate, interaction => {
    if (!interaction.isButton() || !handler) return;
    let answered = false;
    handler({
      id: interaction.id,
      user: interaction.user.id,
      customId: interaction.customId,
      message: interaction.message.id,
      channel: interaction.channelId,
      async deferUpdate() { await interaction.deferUpdate(); answered = true; },
      async ephemeral(text) {
        const message = { content: String(text), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
        if (answered || interaction.replied || interaction.deferred) await interaction.followUp(message);
        else { await interaction.reply(message); answered = true; }
      },
    });
  });
  client.on(Events.Error, error => console.error(`[asks-bot] Discord client error: ${error?.code ?? error?.message}`));

  return {
    onClick(next) { handler = next; },
    async start() {
      await new Promise((resolve, reject) => {
        client.once(Events.ClientReady, resolve);
        client.login(token).catch(reject);
      });
    },
    async stop() { await client.destroy(); },
    /** Open the DM with a user and post a message in it → { channel, message } */
    async sendDM(userId, message) {
      const user = await client.users.fetch(userId);
      const channel = await user.createDM();
      const sent = await client.rest.post(Routes.channelMessages(channel.id), { body: payload(message) });
      return { channel: channel.id, message: sent.id };
    },
    async editMessage({ channel, message }, next) {
      await client.rest.patch(Routes.channelMessage(channel, message), { body: payload(next) });
    },
  };
}
