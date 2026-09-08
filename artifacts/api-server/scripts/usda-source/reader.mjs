import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

const JSON_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

class CharacterStream {
  constructor(filePath) {
    this.iterator = createReadStream(filePath)[Symbol.asyncIterator]();
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.text = "";
    this.offset = 0;
    this.done = false;
  }

  async fill() {
    while (this.offset === this.text.length && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.text = this.decoder.decode();
        this.done = true;
      } else {
        this.text = this.decoder.decode(next.value, { stream: true });
      }
      this.offset = 0;
    }
  }

  async peek() {
    await this.fill();
    return this.offset < this.text.length ? this.text[this.offset] : null;
  }

  async take() {
    const value = await this.peek();
    if (value !== null) this.offset += 1;
    return value;
  }
}

async function whitespace(input) {
  while (JSON_WHITESPACE.has(await input.peek())) await input.take();
}

async function expect(input, expected, message = `expected ${expected}`) {
  const actual = await input.take();
  if (actual !== expected) {
    throw new SyntaxError(`${message}; found ${actual === null ? "end of file" : JSON.stringify(actual)}`);
  }
}

async function readJsonString(input) {
  await expect(input, '"', "expected a JSON object key");
  let raw = '"';
  let escaped = false;
  for (;;) {
    const character = await input.take();
    if (character === null) throw new SyntaxError("truncated JSON string");
    raw += character;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      break;
    } else if (character.charCodeAt(0) < 0x20) {
      throw new SyntaxError("unescaped control character in JSON string");
    }
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError(`invalid JSON string: ${error.message}`);
  }
}

async function readObject(input) {
  await expect(input, "{", "each food must be a JSON object");
  let raw = "{";
  const closers = ["}"];
  let inString = false;
  let escaped = false;

  while (closers.length) {
    await input.fill();
    if (input.offset === input.text.length) throw new SyntaxError("truncated food object");
    const start = input.offset;
    while (input.offset < input.text.length && closers.length) {
      const character = input.text[input.offset++];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        else if (character.charCodeAt(0) < 0x20) {
          throw new SyntaxError("unescaped control character in food object");
        }
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") closers.push("}");
      else if (character === "[") closers.push("]");
      else if (character === "}" || character === "]") {
        if (closers.pop() !== character) throw new SyntaxError("mismatched delimiter in food object");
      }
    }
    raw += input.text.slice(start, input.offset);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError(`invalid food JSON: ${error.message}`);
  }
}

function validateFood(food, dataType) {
  if (!Number.isSafeInteger(food.fdcId) || food.fdcId <= 0) {
    throw new TypeError("food fdcId must be a positive safe integer");
  }
  if (typeof food.description !== "string" || food.description.length === 0) {
    throw new TypeError(`food ${food.fdcId} description must be a nonempty string`);
  }
  if (food.dataType !== dataType) {
    throw new TypeError(`food ${food.fdcId} has dataType ${JSON.stringify(food.dataType)}, expected ${JSON.stringify(dataType)}`);
  }
  if (!Array.isArray(food.foodNutrients)) {
    throw new TypeError(`food ${food.fdcId} foodNutrients must be an array`);
  }
  if ("foodPortions" in food && !Array.isArray(food.foodPortions)) {
    throw new TypeError(`food ${food.fdcId} foodPortions must be an array when present`);
  }
}

function validateSpec(spec) {
  if (!spec || typeof spec.rootKey !== "string" || !spec.rootKey ||
      typeof spec.dataType !== "string" || !spec.dataType) {
    throw new TypeError("spec must contain nonempty rootKey and dataType strings");
  }
  if ("allowNullRecords" in spec && typeof spec.allowNullRecords !== "boolean") {
    throw new TypeError("spec allowNullRecords must be a boolean when present");
  }
}

async function* readRecords(filePath, spec) {
  validateSpec(spec);
  const { rootKey, dataType, allowNullRecords = false } = spec;
  const input = new CharacterStream(filePath);
  let position = 0;
  await whitespace(input);
  await expect(input, "{", "expected one JSON envelope object");
  await whitespace(input);
  const key = await readJsonString(input);
  if (key !== rootKey) {
    throw new TypeError(`unexpected root key ${JSON.stringify(key)}; expected ${JSON.stringify(rootKey)}`);
  }
  await whitespace(input);
  await expect(input, ":", "expected colon after root key");
  await whitespace(input);
  await expect(input, "[", `root key ${JSON.stringify(rootKey)} must contain an array`);
  await whitespace(input);

  if (await input.peek() !== "]") {
    for (;;) {
      if (await input.peek() === "n") {
        if (!allowNullRecords) {
          throw new TypeError(`null food record at position ${position} requires allowNullRecords=true`);
        }
        for (const character of "null") {
          await expect(input, character, `invalid null record at position ${position}`);
        }
        yield { food: null, position };
      } else {
        const food = await readObject(input);
        validateFood(food, dataType);
        yield { food, position };
      }
      position += 1;
      await whitespace(input);
      const separator = await input.take();
      if (separator === "]") break;
      if (separator !== ",") {
        throw new SyntaxError(`expected comma or closing array; found ${separator === null ? "end of file" : JSON.stringify(separator)}`);
      }
      await whitespace(input);
      if (await input.peek() === "]") throw new SyntaxError("trailing comma in foods array");
    }
  } else {
    await input.take();
  }

  await whitespace(input);
  await expect(input, "}", "envelope must contain only the expected array key");
  await whitespace(input);
  if (await input.take() !== null) throw new SyntaxError("trailing content after JSON envelope");
}

export async function* readFoods(filePath, spec) {
  for await (const { food } of readRecords(filePath, spec)) {
    if (food !== null) yield food;
  }
}

async function digestFile(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export async function inspectRelease(filePath, spec) {
  validateSpec(spec);
  const digest = await digestFile(filePath);
  const ids = new Set();
  const nutrientCoverage = Object.create(null);
  let foods = 0;
  let nutrients = 0;
  let portions = 0;
  let withPortions = 0;
  let maxRecordBytes = 0;
  let nullEntries = 0;
  const nullPositions = [];

  for await (const { food, position } of readRecords(filePath, spec)) {
    if (food === null) {
      nullEntries += 1;
      nullPositions.push(position);
      continue;
    }
    if (ids.has(food.fdcId)) throw new TypeError(`duplicate fdcId ${food.fdcId}`);
    ids.add(food.fdcId);
    foods += 1;
    nutrients += food.foodNutrients.length;
    const foodPortions = food.foodPortions;
    if (Array.isArray(foodPortions)) {
      portions += foodPortions.length;
      if (foodPortions.length > 0) withPortions += 1;
    }
    maxRecordBytes = Math.max(maxRecordBytes, Buffer.byteLength(JSON.stringify(food)));

    const covered = new Set();
    for (const entry of food.foodNutrients) {
      const id = entry?.nutrient?.id ?? entry?.nutrientId;
      if (id !== undefined && id !== null &&
          typeof entry?.amount === "number" && Number.isFinite(entry.amount)) {
        covered.add(String(id));
      }
    }
    for (const id of covered) nutrientCoverage[id] = (nutrientCoverage[id] ?? 0) + 1;
  }

  return {
    ...digest,
    foods,
    sourceEntries: foods + nullEntries,
    nullEntries,
    nullPositions,
    nutrients,
    portions,
    withPortions,
    maxRecordBytes,
    nutrientCoverage,
  };
}

export async function* foodBatches(
  filePath,
  spec,
  { maxBytes = 650000, maxFoods = 100 } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    throw new TypeError("maxBytes must be a safe integer of at least 2");
  }
  if (!Number.isSafeInteger(maxFoods) || maxFoods <= 0) {
    throw new TypeError("maxFoods must be a positive safe integer");
  }

  let foods = [];
  let bytes = 2;
  for await (const food of readFoods(filePath, spec)) {
    const foodBytes = Buffer.byteLength(JSON.stringify(food));
    if (foodBytes + 2 > maxBytes) {
      throw new RangeError(`food ${food.fdcId} exceeds maxBytes when serialized as an array`);
    }
    const nextBytes = bytes + foodBytes + (foods.length ? 1 : 0);
    if (foods.length && (foods.length === maxFoods || nextBytes > maxBytes)) {
      yield { foods, bytes };
      foods = [];
      bytes = 2;
    }
    bytes += foodBytes + (foods.length ? 1 : 0);
    foods.push(food);
  }
  if (foods.length) yield { foods, bytes };
}