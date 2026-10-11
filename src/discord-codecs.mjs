import { isObjectRecord as record } from "@red-cup-engineering/json-services-section";

function text(value) { return typeof value === "string" && value.length > 0; }
function optionalText(value) { return value === undefined || typeof value === "string"; }
function carrier(admit) {
  return Object.freeze({ assert(value, label = "Discord value") {
    if (!record(value) || !admit(value)) throw new TypeError(`${label} does not conform to the Discord HTTP projection`);
    return value;
  } });
}

const option = (value) => record(value) && text(value.name) && text(value.description) && (value.required === undefined || typeof value.required === "boolean");

export const discordUserCarrier = carrier((v) => v.kind === "discord.user" && text(v.id) && text(v.username) && (v.bot === undefined || typeof v.bot === "boolean"));
export const discordGuildCarrier = carrier((v) => v.kind === "discord.guild" && text(v.id) && text(v.name) && optionalText(v.ownerId));
export const discordRoleCarrier = carrier((v) => v.kind === "discord.role" && text(v.id) && text(v.name) && optionalText(v.permissions) && (v.managed === undefined || typeof v.managed === "boolean") && (v.position === undefined || Number.isInteger(v.position)));
export const discordPermissionOverwriteCarrier = carrier((v) => v.kind === "discord.permission-overwrite" && text(v.id) && ["role", "member"].includes(String(v.type)) && text(v.allow) && text(v.deny));
export const discordChannelTypes = Object.freeze({ text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16 });
export const discordChannelCarrier = carrier((v) => v.kind === "discord.channel" && text(v.id) && text(v.name) && optionalText(v.topic) && (v.permissionOverwrites === undefined || Array.isArray(v.permissionOverwrites)) && (v.type === undefined || typeof v.type === "string") && (v.parentId === undefined || v.parentId === null || text(v.parentId)) && (v.position === undefined || Number.isInteger(v.position)));
export const discordOnboardingCarrier = carrier((v) => v.kind === "discord.onboarding" && typeof v.enabled === "boolean" && Number.isInteger(v.mode) && Array.isArray(v.defaultChannelIds) && v.defaultChannelIds.every(text) && Array.isArray(v.prompts) && v.prompts.every((prompt) => text(prompt.title) && Array.isArray(prompt.options) && prompt.options.every((option) => text(option.title) && Array.isArray(option.channelIds) && Array.isArray(option.roleIds))));
export const discordMessageCarrier = carrier((v) => v.kind === "discord.message" && [v.id, v.channelId, v.authorId, v.authorName, v.timestamp].every(text) && typeof v.authorBot === "boolean" && typeof v.content === "string" && optionalText(v.replyToId) && Array.isArray(v.mentionedUserIds) && v.mentionedUserIds.every(text));
export const discordCommandOptionCarrier = carrier((v) => option(v));
export const discordCommandCarrier = carrier((v) => v.kind === "discord.command" && [v.id, v.name, v.description].every(text) && (v.options === undefined || Array.isArray(v.options) && v.options.every(option)) && optionalText(v.defaultMemberPermissions) && (v.dmPermission === undefined || typeof v.dmPermission === "boolean"));
export const discordInteractionCarrier = carrier((v) => v.kind === "discord.interaction" && text(v.id) && text(v.applicationId) && ["ping", "application-command", "message-component", "modal-submit", "autocomplete"].includes(String(v.type)) && text(v.token) && Number.isInteger(v.version) && Number(v.version) >= 1 && [v.commandName, v.commandId, v.guildId, v.channelId, v.userId, v.username].every(optionalText));
export const discordInteractionResponseCarrier = carrier((v) => v.kind === "discord.interaction-response" && ["pong", "channel-message-with-source", "deferred-channel-message-with-source"].includes(String(v.type)) && optionalText(v.content) && (v.ephemeral === undefined || typeof v.ephemeral === "boolean"));
export const discordGuildBoostStatusCarrier = carrier((v) => v.kind === "discord.guild-boost-status" && text(v.guildId) && [0, 1, 2, 3].includes(v.premiumTier) && Number.isInteger(v.boostCount) && Number(v.boostCount) >= 0);
export const discordEmojiCarrier = carrier((v) => v.kind === "discord.emoji" && text(v.id) && text(v.name) && typeof v.animated === "boolean" && typeof v.available === "boolean");
export const discordStickerCarrier = carrier((v) => v.kind === "discord.sticker" && text(v.id) && text(v.name) && optionalText(v.description) && typeof v.tags === "string" && ["png", "apng", "lottie", "gif"].includes(String(v.format)) && typeof v.available === "boolean");
