const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function makeNode(id, name, y, children = []) {
  const node = {
    id,
    name,
    type: "FRAME",
    x: 0,
    y,
    width: 600,
    height: 100,
    absoluteBoundingBox: { x: 0, y, width: 600, height: 100 },
    children,
    exportAsync() {}
  };
  for (const child of children) child.parent = node;
  node.findAll = (predicate) => {
    const descendants = [];
    const visit = (current) => current.children.forEach((child) => {
      descendants.push(child);
      visit(child);
    });
    visit(node);
    return descendants.filter(predicate);
  };
  return node;
}

function codeApi(selection) {
  const source = fs.readFileSync("code.js", "utf8")
    + "\n;globalThis.__sliceTest = { detectAfeetSlices, exportCorpoBackgroundSlice, detectSkuModel };";
  const figma = {
    currentPage: { selection },
    ui: { onmessage: null, postMessage() {} },
    showUI() {},
    on() {},
    notify() {}
  };
  const context = { figma, __html__: "", console: { log() {} }, setTimeout, clearTimeout, URL, fetch() {} };
  vm.runInNewContext(source, context);
  return context.__sliceTest;
}

test("recognizes every SKU model present in the AF guide template", () => {
  const api = codeApi([]);

  assert.equal(api.detectSkuModel("SKU [DE_POR_PARCELADO] 1"), "de_por_parcelado");
  assert.equal(api.detectSkuModel("SKU [DE_POR] 1"), "de_por");
  assert.equal(api.detectSkuModel("SKU [PARCELADO] 1"), "parcelado");
  assert.equal(api.detectSkuModel("SKU [PARCELADO MENOR] 1"), "parcelado");
  assert.equal(api.detectSkuModel("SKU [CONFIRA AS FORMAS] 1"), "confira_as_formas");
  assert.equal(api.detectSkuModel("SKU [A_VISTA] 1"), "a_vista");
});

test("CORPO slices are included and retain the visual email order across TEXTO and IMG", () => {
  const body = makeNode("corpo", "CORPO", 200, [
    makeNode("text-1", "TEXTO", 220),
    makeNode("image-1", "IMG", 320),
    makeNode("text-2", "TEXTO 2", 420),
    makeNode("image-2", "IMG 2", 520)
  ]);
  const root = makeNode("email", "EMKT", 0, [
    makeNode("header", "HEADER", 0),
    makeNode("hero", "HERO", 100),
    body
  ]);
  const api = codeApi([root]);

  const result = api.detectAfeetSlices();

  assert.deepEqual(
    JSON.parse(JSON.stringify(result.emails[0].items.map((item) => item.label))),
    ["HEADER", "HERO", "CORPO_BG", "TEXTO", "IMG", "TEXTO 2", "IMG 2"]
  );
});

test("ESPAÇADOR is exported from CORPO, VITRINE, or the e-mail root", () => {
  const vitrine = makeNode("vitrine", "VITRINE", 350, [
    makeNode("spacer-vitrine", "ESPAÇADOR", 370)
  ]);
  const corpo = makeNode("corpo", "CORPO", 200, [
    makeNode("spacer-corpo", "ESPAÇADOR", 220),
    vitrine
  ]);
  const root = makeNode("email", "EMKT", 0, [
    corpo,
    makeNode("spacer-root", "ESPAÇADOR", 600)
  ]);
  const api = codeApi([root]);

  const result = api.detectAfeetSlices();
  const spacers = result.emails[0].items.filter((item) => item.label === "ESPAÇADOR");

  assert.deepEqual(
    JSON.parse(JSON.stringify(spacers.map((item) => item.nodeId))),
    ["spacer-corpo", "spacer-vitrine", "spacer-root"]
  );
});

test("CORPO export uses an isolated clone and does not change the source layers", async () => {
  const child = makeNode("content", "IMG", 10);
  child.visible = true;
  const corpo = makeNode("corpo", "CORPO", 0, [child]);
  const cloneChild = makeNode("clone-content", "IMG", 10);
  cloneChild.visible = true;
  let exportedWithCloneChildHidden = false;
  const clone = makeNode("clone", "CORPO", 0, [cloneChild]);
  clone.exportAsync = async () => {
    exportedWithCloneChildHidden = cloneChild.visible === false;
    return new Uint8Array([1, 2, 3]);
  };
  clone.remove = () => {};
  corpo.clone = () => clone;

  const source = fs.readFileSync("code.js", "utf8")
    + "\n;globalThis.__sliceTest = { exportCorpoBackgroundSlice };";
  const figma = {
    currentPage: {
      selection: [],
      async loadAsync() {},
      appendChild(node) { node.parent = this; }
    },
    getNodeById: () => corpo,
    ui: { onmessage: null, postMessage() {} },
    showUI() {},
    on() {},
    notify() {}
  };
  const context = { figma, __html__: "", console: { log() {} }, setTimeout, clearTimeout, URL, fetch() {} };
  vm.runInNewContext(source, context);

  const bytes = await context.__sliceTest.exportCorpoBackgroundSlice("corpo", 2);

  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  assert.equal(exportedWithCloneChildHidden, true);
  assert.equal(child.visible, true);
});
