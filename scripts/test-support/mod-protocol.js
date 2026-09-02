import { readFile } from "node:fs/promises";

// The login protocol, read out of the agent's own source instead of written down a second
// time. Everything that speaks this protocol - the stand check, the consistency test - takes
// the numbers, the channel names and the field order from here.
//
// The reason is a scar. The stand check used to hard-code the login-phase channel and
// protocol 1; the agent moved the question into the configuration phase and the check kept
// asserting against a channel that no longer existed. It did not start failing - it simply
// stopped covering the handshake, and nobody noticed for two releases. A test that can drift
// out of date without saying so is worse than no test, because it is counted as coverage.
const root = new URL("../../minecraft/", import.meta.url);
const LOGIN_SOURCE = new URL("udmc-sync-common/src/main/java/dev/udmc/sync/AgentLoginProtocol.java", root);
const PAYLOADS = { query: "UdmcQueryPayload", answer: "UdmcAnswerPayload", project: "UdmcProjectPayload", register: "UdmcRegisterPayload" };
const VARIANTS = ["classic", "modern"];

const constant = (source, name) => {
  const match = new RegExp(`public static final int ${name}\\s*=\\s*(\\d+)\\s*;`).exec(source);
  if (!match) throw new Error(`${name} is no longer declared in AgentLoginProtocol: every check that speaks it has to be revisited`);
  return Number(match[1]);
};

const channelOf = (source, file) => {
  const match = /(?:Identifier|ResourceLocation)\.fromNamespaceAndPath\("([^"]+)",\s*"([^"]+)"\)/.exec(source);
  if (!match) throw new Error(`${file} no longer declares a channel id`);
  return `${match[1]}:${match[2]}`;
};

/** The fields a payload puts on the wire, in order, as its write method spells them out. */
const fieldsOf = (source, file) => {
  const body = /public void write\(FriendlyByteBuf output\) \{([\s\S]*?)\n {4}\}/.exec(source);
  if (!body) throw new Error(`${file} no longer has a readable write method`);
  const fields = [...body[1].matchAll(/output\.write(VarInt|Utf|Boolean|Bytes)\(([^;]*)\);/g)].map(([, kind, args]) => {
    const limit = /,\s*(\d+)\s*\)?\s*$/.exec(args);
    return kind === "VarInt" ? "varint" : kind === "Boolean" ? "bool" : kind === "Bytes" ? "bytes" : `utf:${limit ? limit[1] : "?"}`;
  });
  if (!fields.length) throw new Error(`${file} writes nothing: the parser or the payload changed`);
  return fields;
};

export async function loginProtocol() {
  const login = await readFile(LOGIN_SOURCE, "utf8");
  const channels = {}, fields = {}, variants = {};
  for (const [name, file] of Object.entries(PAYLOADS)) {
    for (const variant of VARIANTS) {
      const source = await readFile(new URL(`udmc-sync-fabric/src/network/${variant}/dev/udmc/sync/network/${file}.java`, root), "utf8");
      variants[`${name}.${variant}`] = { channel: channelOf(source, `${variant}/${file}`), fields: fieldsOf(source, `${variant}/${file}`) };
    }
    channels[name] = variants[`${name}.classic`].channel;
    fields[name] = variants[`${name}.classic`].fields;
  }
  return { protocol: constant(login, "PROTOCOL"), queryProtocol: constant(login, "QUERY_PROTOCOL"), channels, fields, variants };
}
