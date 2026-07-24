import { AsyncEntry } from "@napi-rs/keyring";

const id = `${process.platform}-${process.pid}-${Date.now()}`;
const entry = new AsyncEntry("co.polymux.cli.ci", id);
const expected = `credential-${id}`;
await entry.setPassword(expected);
const actual = await entry.getPassword();
if (actual !== expected) throw new Error("Native keyring round trip failed");
await entry.deletePassword();
process.stdout.write(`Native credential round trip passed on ${process.platform}.\n`);
