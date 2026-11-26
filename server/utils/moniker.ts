import fs from "node:fs";
import { randomInt } from "node:crypto";

const adjectives = fs
  .readFileSync(process.cwd() + "/words/adjectives.txt")
  .toString()
  .split(/\r?\n/);
const nouns = fs
  .readFileSync(process.cwd() + "/words/nouns.txt")
  .toString()
  .split(/\r?\n/);
const verbs = fs
  .readFileSync(process.cwd() + "/words/verbs.txt")
  .toString()
  .split(/\r?\n/);
const randomElement = (array: string[]) =>
  array[Math.floor(Math.random() * array.length)];

export function makeRoomName() {
  const adjective = randomElement(adjectives);
  const noun = randomElement(nouns);
  const verb = randomElement(verbs);
  return `${adjective}-${noun}-${verb}`;
}

export function makeUserName() {
  return `${capFirst(randomElement(adjectives))} ${capFirst(
    randomElement(nouns),
  )}`;
}

function capFirst(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * A readable room password like "otter-maple-42": adjective-noun-two digits, picked with crypto.randomInt
 * (about 27 bits; the join endpoint is rate limited).
 */
export function makeRoomPassword() {
  const pick = (list: string[]) => {
    const words = list.filter(Boolean);
    return words[randomInt(words.length)];
  };
  const digits = String(randomInt(100)).padStart(2, "0");
  return `${pick(adjectives)}-${pick(nouns)}-${digits}`;
}
