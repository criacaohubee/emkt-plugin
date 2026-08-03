const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

function uiApi() {
  const html = fs.readFileSync("ui.html", "utf8");
  const source = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i)[1]
    + "\n;globalThis.__uiTest = { extractUrlFromText, parseBriefing, handleTableInput, setProducts: (products) => { state.products = products; }, getProducts: () => state.products };";
  const elements = new Map();
  const element = () => ({
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
    style: {},
    value: "",
    textContent: "",
    hidden: false,
    disabled: false
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelector() { return element(); },
    createElement() { return { click() {} }; }
  };
  const window = { addEventListener() {}, setTimeout() {} };
  const context = {
    window,
    document,
    parent: { postMessage() {} },
    console: { log() {}, warn() {} },
    URL,
    Blob,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    setTimeout() {},
    clearTimeout() {}
  };
  vm.runInNewContext(source, context);
  return context.__uiTest;
}

const ui = uiApi();

test("briefing URLs populate the corresponding product URL", () => {
  const result = ui.parseBriefing(`VITRINES:\n1 - Tênis SKU-A\nURL: https://www.authenticfeet.com.br/tenis-a\n2 - Tênis SKU-B\nLINK: https://www.authenticfeet.com.br/tenis-b`);
  assert.equal(result.products[0].url, "https://www.authenticfeet.com.br/tenis-a");
  assert.equal(result.products[1].url, "https://www.authenticfeet.com.br/tenis-b");
  assert.notEqual(result.products[0].url, result.products[1].url);
});

test("normalizes plain and Markdown product URLs without retaining markup", () => {
  assert.equal(ui.extractUrlFromText("https://www.artwalk.com.br/produto/p?cor=azul#detalhes"), "https://www.artwalk.com.br/produto/p?cor=azul");
  assert.equal(ui.extractUrlFromText("[Ver produto](https://www.artwalk.com.br/produto/p)"), "https://www.artwalk.com.br/produto/p");
  assert.equal(ui.extractUrlFromText("[https://www.artwalk.com.br/produto/p](https://www.artwalk.com.br/produto/p)"), "https://www.artwalk.com.br/produto/p");
  assert.equal(ui.extractUrlFromText("[Ver produto] ( https://www.artwalk.com.br/produto/p ),;"), "https://www.artwalk.com.br/produto/p");
  assert.equal(ui.extractUrlFromText("<https://www.artwalk.com.br/produto/p),;>"), "https://www.artwalk.com.br/produto/p");
});

test("recognizes every real Artwalk Markdown URL in the briefing fixture", () => {
  const briefing = fs.readFileSync("tests/fixtures/artwalk-markdown-briefing.txt", "utf8");
  const products = ui.parseBriefing(briefing).products;
  assert.deepEqual(JSON.parse(JSON.stringify(products.map((product) => ({ index: product.index, title: product.title, url: product.url })))), [
    { index: 1, title: "Tênis adidas Megaride 1 Unissex", url: "https://www.artwalk.com.br/tenis-adidas-megaride-01-unissex-jr693-7-001/p" },
    { index: 2, title: "Tênis adidas Megaride AG Unissex", url: "https://www.artwalk.com.br/tenis-adidas-megaride-ag-unissex-kj796-4-600/p" },
    { index: 3, title: "Tênis adidas Megaride Unissex", url: "https://www.artwalk.com.br/tenis-adidas-megaride-unissex-jr219-1-001/p" },
    { index: 4, title: "Tênis adidas Megaride Masculino", url: "https://www.artwalk.com.br/tenis-adidas-megaride-masculino-kk063-4-400/p" }
  ]);
});

test("editing a URL clears its resolved image so the SKU uses the new link", () => {
  ui.setProducts([
    { sku: "SKU-A", title: "A", url: "https://www.authenticfeet.com.br/a" },
    { sku: "SKU-B", title: "B", url: "https://www.authenticfeet.com.br/b", imageUrl: "https://cdn.example/antiga.jpg" }
  ]);
  ui.handleTableInput({ target: { dataset: { index: "1", field: "url" }, value: "https://www.authenticfeet.com.br/b-editado" } });
  assert.equal(ui.getProducts()[1].url, "https://www.authenticfeet.com.br/b-editado");
  assert.equal(ui.getProducts()[1].imageUrl, "");
});

test("normal image resolution remains part of the analysis and application paths", () => {
  const html = fs.readFileSync("ui.html", "utf8");
  const code = fs.readFileSync("code.js", "utf8");
  assert.match(html, /sku-models-detected[\s\S]*?resolveImages\(\)/);
  assert.match(code, /if \(!product\.imageUrl && product\.url\)[\s\S]*?await resolveProductImageUrl/);
});

function parseSingleProduct(priceLine) {
  return ui.parseBriefing(`1 - Produto de teste\n${priceLine}\nCTA: COMPRAR`).products[0];
}

test("parses the cash price after OU for installments with Pix text and discount", () => {
  const product = parseSingleProduct("10x de R$ 129,99 sem juros OU R$ 1.234,99 no pix à vista 5% OFF");

  assert.equal(product.installmentCount, "10x");
  assert.equal(product.installmentValue, "R$ 129,99");
  assert.equal(product.cashPrice, "R$ 1.234,99");
  assert.equal(product.price, "R$ 1.234,99");
  assert.equal(product.discount, "5%");
  assert.equal(product.cta, "COMPRAR");
  assert.notEqual(product.cashPrice, product.installmentValue);
});

test("parses Pix installment prices without a discount", () => {
  const product = parseSingleProduct("10x de R$ 129,99 sem juros OU R$ 1.234,99 no pix à vista");

  assert.equal(product.installmentCount, "10x");
  assert.equal(product.installmentValue, "R$ 129,99");
  assert.equal(product.cashPrice, "R$ 1.234,99");
  assert.equal(product.discount, "");
});

test("supports case and spacing variations around OU, PIX and OFF", () => {
  const product = parseSingleProduct("10xdeR$179,99 sem jurosouR$1.709,99 no PIX a vista 5% off");

  assert.equal(product.installmentCount, "10x");
  assert.equal(product.installmentValue, "R$ 179,99");
  assert.equal(product.cashPrice, "R$ 1.709,99");
  assert.equal(product.discount, "5%");
});

test("keeps legacy installment, cash-only, DE/POR and combined SKU price formats", () => {
  const legacyInstallment = parseSingleProduct("6x de R$ 99,99 sem juros OU R$ 599,99 50% OFF");
  const discountWithoutOff = parseSingleProduct("6x de R$ 99,99 sem juros OU R$ 599,99 50%");
  const cashOnly = parseSingleProduct("R$ 599,99 50% OFF");
  const dePor = parseSingleProduct("DE: R$ 799,99 POR R$ 599,99 25% OFF");
  const combined = parseSingleProduct("DE: R$ 2.099,99 POR R$ 1.709,99 ou 10x de R$ 170,99 sem juros 19% OFF");

  assert.deepEqual(JSON.parse(JSON.stringify({
    cashPrice: legacyInstallment.cashPrice,
    installmentCount: legacyInstallment.installmentCount,
    installmentValue: legacyInstallment.installmentValue,
    discount: legacyInstallment.discount
  })), {
    cashPrice: "R$ 599,99",
    installmentCount: "6x",
    installmentValue: "R$ 99,99",
    discount: "50%"
  });
  assert.equal(discountWithoutOff.discount, "50%");
  assert.equal(cashOnly.cashPrice, "R$ 599,99");
  assert.equal(cashOnly.discount, "50%");
  assert.equal(dePor.oldPrice, "R$ 799,99");
  assert.equal(dePor.cashPrice, "R$ 599,99");
  assert.equal(combined.oldPrice, "R$ 2.099,99");
  assert.equal(combined.cashPrice, "R$ 1.709,99");
  assert.equal(combined.installmentCount, "10x");
  assert.equal(combined.installmentValue, "R$ 170,99");
});
