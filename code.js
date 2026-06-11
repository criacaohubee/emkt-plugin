try {
  figma.showUI(__html__, {
    width: 1080,
    height: 860,
    themeColors: true
  });
} catch (error) {
  figma.notify(`Erro ao abrir UI: ${readError(error)}`);
  throw error;
}

if ("skipInvisibleInstanceChildren" in figma) {
  figma.skipInvisibleInstanceChildren = true;
}

console.log("[Afeet - E-mail MKT Automator] main loaded");

const IMAGE_RESOLVE_CONCURRENCY = 8;
const JSON_FETCH_TIMEOUT_MS = 6000;
const HTML_FETCH_TIMEOUT_MS = 8000;
const READER_FETCH_TIMEOUT_MS = 8000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 12000;
const PERSISTENT_IMAGE_CACHE_PREFIX = "hubee-vitrine-image::";
const productImageCache = {};
const productImagePendingCache = {};
const figmaImageHashCache = {};

const FIELD_ALIASES = {
  discount: ["DESCONTO", "PORCENTAGEM DE DESCONTO"],
  title: ["TITULO"],
  image: ["IMAGEM"],
  installmentCount: ["NUMERO DE PARCELAS"],
  installmentValue: ["VALOR PARCELADO"],
  cashPrice: ["VALOR A VISTA"],
  cta: ["CTA"]
};

figma.on("selectionchange", postSelectionSummary);
postSelectionSummary();

figma.ui.onmessage = async (message) => {
  try {
    if (message.type === "resolve-images") {
      await resolveProductImages(message.products || [], message.proxyTemplate || "");
      return;
    }

    if (message.type === "apply-products") {
      const result = await applyProducts(message.products || [], message.settings || {});
      figma.ui.postMessage({ type: "apply-complete", result });
      const skippedText = result.skipped ? ` ${result.skipped} produto(s) sem SKU.` : "";
      figma.notify(`Vitrine aplicada: ${result.applied}/${result.requested} SKUs.${skippedText}`);
      return;
    }

    if (message.type === "detect-slices") {
      const result = detectAfeetSlices();
      figma.ui.postMessage({ type: "slice-detect-complete", result });
      figma.notify(`${result.items.length} fatia(s) detectada(s).`);
      return;
    }

    if (message.type === "export-slices") {
      const result = await exportAfeetSlices(message.items || [], message.scale || 2);
      figma.ui.postMessage({ type: "slice-export-complete", result });
      const failureText = result.failures && result.failures.length ? ` ${result.failures.length} falha(s).` : "";
      figma.notify(`Exportacao AFEET concluida: ${result.files.length} arquivo(s).${failureText}`);
      return;
    }

    if (message.type === "resize-ui") {
      figma.ui.resize(message.width || 1080, message.height || 860);
      return;
    }

    if (message.type === "notify") {
      figma.notify(message.message || "");
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "plugin-error",
      error: readError(error)
    });
  }
};

function postSelectionSummary() {
  try {
    const selection = figma.currentPage.selection;
    const selected = selection[0];
    const skuCount = selected ? safeFindSkuNodes(selected).length : 0;
    figma.ui.postMessage({
      type: "selection-summary",
      summary: selected
        ? `${selected.name} (${selected.type}) - ${skuCount} SKU(s) encontrado(s)`
        : "Nenhum frame selecionado"
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "selection-summary",
      summary: `Selecao carregada, mas nao consegui contar SKUs: ${readError(error)}`
    });
  }
}

function safeFindSkuNodes(root) {
  try {
    return findSkuNodes(root);
  } catch (_error) {
    return [];
  }
}

function detectAfeetSlices() {
  const root = figma.currentPage.selection[0];
  if (!root) {
    throw new Error("Selecione o frame principal do e-mail antes de detectar as fatias.");
  }

  const items = [];
  const seenNodeIds = {};
  const header = findFirstExportNodeByName(root, ["HEADER"]);
  const hero = findFirstExportNodeByName(root, ["HERO"]);
  const corpo = findFirstExportNodeByName(root, ["CORPO"]);
  const bannerApp = findFirstExportNodeByName(root, ["BANNER APP"]);
  const footerIcons = findFirstExportNodeByName(root, ["FOOTER - ICONS", "FOOTER ICONS"]);
  const footerRedes = findFirstExportNodeByName(root, ["FOOTER - REDES", "FOOTER REDES"]);

  addDetectedSlice(items, seenNodeIds, header, "HEADER", "node");
  addDetectedSlice(items, seenNodeIds, hero, "HERO", "node");

  if (corpo) {
    items.push({
      id: `virtual-corpo-bg-${corpo.id}`,
      nodeId: corpo.id,
      label: "CORPO_BG",
      kind: "corpo-bg",
      selected: true
    });

    const textNodes = findTextoNodes(corpo);
    for (const textNode of textNodes) {
      addDetectedSlice(items, seenNodeIds, textNode, textNode.name, "node");
    }

    const skuNodes = findExportSkuNodes(corpo);
    for (const skuNode of skuNodes) {
      addDetectedSlice(items, seenNodeIds, skuNode, skuNode.name, "node");
    }
  }

  addDetectedSlice(items, seenNodeIds, bannerApp, "BANNER APP", "node");
  addDetectedSlice(items, seenNodeIds, footerIcons, "FOOTER - ICONS", "node");

  const socialNodes = findFooterSocialNodes(footerRedes);
  for (const socialNode of socialNodes) {
    addDetectedSlice(items, seenNodeIds, socialNode, socialNode.name, "node");
  }

  return {
    rootName: root.name,
    items
  };
}

function addDetectedSlice(items, seenNodeIds, node, label, kind) {
  if (!node || !isExportableNode(node) || seenNodeIds[node.id]) {
    return;
  }

  seenNodeIds[node.id] = true;
  items.push({
    id: node.id,
    nodeId: node.id,
    label: label || node.name,
    kind,
    selected: true
  });
}

function findFirstExportNodeByName(root, names) {
  const normalizedNames = names.map(normalizeLayerName);

  if (normalizedNames.includes(normalizeLayerName(root.name)) && isExportableNode(root)) {
    return root;
  }

  if (typeof root.findAll !== "function") {
    return null;
  }

  const matches = root.findAll((node) => {
    return isExportableNode(node) && normalizedNames.includes(normalizeLayerName(node.name));
  });

  matches.sort(compareTopLeft);
  return matches[0] || null;
}

function findTextoNodes(corpo) {
  if (!corpo || typeof corpo.findAll !== "function") {
    return [];
  }

  const nodes = corpo.findAll((node) => {
    const name = normalizeLayerName(node.name);
    return isExportableNode(node) && /^TEXTO(?:\s+\d+)?$/.test(name);
  });

  nodes.sort(compareTextSliceNodes);
  return nodes;
}

function compareTextSliceNodes(a, b) {
  const aNumber = textSliceNumber(a.name);
  const bNumber = textSliceNumber(b.name);

  if (aNumber !== bNumber) {
    return aNumber - bNumber;
  }

  return compareTopLeft(a, b);
}

function textSliceNumber(name) {
  const normalized = normalizeLayerName(name);
  if (normalized === "TEXTO") {
    return 0;
  }

  const match = normalized.match(/^TEXTO\s+(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function findExportSkuNodes(root) {
  const nodes = [];

  if (isSkuNode(root) && isExportableNode(root)) {
    nodes.push(root);
  }

  if (typeof root.findAll === "function") {
    appendItems(nodes, root.findAll((node) => isExportableNode(node) && isSkuNode(node)));
  }

  const unique = uniqueNodes(nodes);
  unique.sort(compareSkuNodes);
  return unique;
}

function findFooterSocialNodes(footerRedes) {
  if (!footerRedes || !("children" in footerRedes)) {
    return [];
  }

  const nodes = [];
  for (const child of footerRedes.children) {
    if (isExportableNode(child)) {
      nodes.push(child);
    }
  }

  nodes.sort(compareTopLeft);
  return nodes;
}

async function exportAfeetSlices(items, scale) {
  const selectedItems = items.filter((item) => item && item.selected !== false);
  const safeScale = clampExportScale(scale);
  const files = [];
  const failures = [];

  for (let index = 0; index < selectedItems.length; index += 1) {
    const item = selectedItems[index];
    const fileName = `${padNumber(index + 1)}_${sliceFileStem(item.label)}.png`;

    try {
      const bytes = item.kind === "corpo-bg"
        ? await exportCorpoBackgroundSlice(item.nodeId, safeScale)
        : await exportNodeSlice(item.nodeId, safeScale);

      files.push({
        name: fileName,
        label: item.label,
        bytes
      });
    } catch (error) {
      failures.push({
        label: item.label || fileName,
        reason: readError(error)
      });
    }

    figma.ui.postMessage({
      type: "slice-export-progress",
      done: index + 1,
      total: selectedItems.length
    });
  }

  return {
    files,
    failures,
    scale: safeScale
  };
}

async function exportNodeSlice(nodeId, scale) {
  const node = await getNodeByIdSafe(nodeId);
  if (!isExportableNode(node)) {
    throw new Error("Camada nao encontrada ou nao exportavel.");
  }

  return node.exportAsync({
    format: "PNG",
    constraint: {
      type: "SCALE",
      value: scale
    }
  });
}

async function exportCorpoBackgroundSlice(nodeId, scale) {
  const corpo = await getNodeByIdSafe(nodeId);
  if (!isExportableNode(corpo) || typeof corpo.clone !== "function") {
    throw new Error("Camada CORPO nao encontrada ou nao pode ser clonada.");
  }

  const originalBounds = getNodeBounds(corpo);
  const clone = corpo.clone();

  try {
    detachTemporaryClone(clone, originalBounds);
    lockNodeSize(clone, originalBounds.width, originalBounds.height);
    hideCorpoForegroundInClone(clone);
    return await clone.exportAsync({
      format: "PNG",
      constraint: {
        type: "SCALE",
        value: scale
      }
    });
  } finally {
    try {
      clone.remove();
    } catch (_error) {
      // Temporary clone cleanup should not hide the original export error.
    }
  }
}

function detachTemporaryClone(clone, originalBounds) {
  try {
    figma.currentPage.appendChild(clone);
    if ("x" in clone) {
      clone.x = originalBounds.x;
    }
    if ("y" in clone) {
      clone.y = originalBounds.y;
    }
  } catch (_error) {
    // If the node type cannot be reparented, still export and remove the temporary clone.
  }
}

function hideCorpoForegroundInClone(clone) {
  if (typeof clone.findAll !== "function") {
    return;
  }

  const nodes = clone.findAll((node) => {
    const name = normalizeLayerName(node.name);
    return /^TEXTO(?:\s+\d+)?$/.test(name) ||
      name === "VITRINE" ||
      name === "VITRINES" ||
      /^SKU\s*\d+\b/.test(name);
  });

  for (const node of nodes) {
    if ("visible" in node) {
      node.visible = false;
    }
  }
}

function lockNodeSize(node, width, height) {
  const safeWidth = Math.max(1, width || node.width || 1);
  const safeHeight = Math.max(1, height || node.height || 1);

  if ("layoutSizingHorizontal" in node) {
    try {
      node.layoutSizingHorizontal = "FIXED";
    } catch (_error) {
      // Some node types expose the property but do not allow writes.
    }
  }

  if ("layoutSizingVertical" in node) {
    try {
      node.layoutSizingVertical = "FIXED";
    } catch (_error) {
      // Some node types expose the property but do not allow writes.
    }
  }

  if (typeof node.resizeWithoutConstraints === "function") {
    node.resizeWithoutConstraints(safeWidth, safeHeight);
    return;
  }

  if (typeof node.resize === "function") {
    node.resize(safeWidth, safeHeight);
  }
}

async function getNodeByIdSafe(nodeId) {
  if (typeof figma.getNodeByIdAsync === "function") {
    return figma.getNodeByIdAsync(nodeId);
  }

  return figma.getNodeById(nodeId);
}

function isExportableNode(node) {
  return Boolean(node && typeof node.exportAsync === "function");
}

function clampExportScale(scale) {
  const value = Number(scale);
  if (value === 1 || value === 2 || value === 3) {
    return value;
  }

  return 2;
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function sliceFileStem(label) {
  const normalized = normalizeLayerName(label)
    .replace(/-/g, " ")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "FATIA";
}

async function resolveProductImages(products, proxyTemplate) {
  const resolved = [];
  let nextIndex = 0;
  let done = 0;

  for (let index = 0; index < products.length; index += 1) {
    resolved[index] = cloneProduct(products[index]);
  }

  if (products.length === 0) {
    figma.ui.postMessage({ type: "resolve-complete", products: resolved });
    return;
  }

  const workerCount = Math.min(IMAGE_RESOLVE_CONCURRENCY, products.length);
  const workers = [];

  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    workers.push(resolveImageWorker());
  }

  await Promise.all(workers);
  figma.ui.postMessage({ type: "resolve-complete", products: resolved });

  async function resolveImageWorker() {
    while (nextIndex < products.length) {
      const index = nextIndex;
      nextIndex += 1;

      const nextProduct = await resolveProductImageForRow(products[index], proxyTemplate);
      resolved[index] = nextProduct;
      done += 1;

      figma.ui.postMessage({
        type: "resolve-progress",
        rowIndex: index,
        done,
        total: products.length,
        product: nextProduct
      });
    }
  }
}

async function resolveProductImageForRow(product, proxyTemplate) {
  let imageUrl = product.imageUrl || "";
  let imageError = "";

  if (!imageUrl && product.url) {
    try {
      imageUrl = await resolveProductImageUrl(product, proxyTemplate);
      if (!imageUrl) {
        imageError = "Imagem principal nao encontrada.";
      }
    } catch (error) {
      imageError = readError(error);
    }
  }

  const nextProduct = cloneProduct(product);
  nextProduct.imageUrl = cleanImageUrl(imageUrl);
  nextProduct.imageStatus = imageUrl ? "ok" : "error";
  nextProduct.imageError = imageError;

  return nextProduct;
}

async function fetchProductHtml(url, proxyTemplate) {
  const targetUrl = buildProxyUrl(proxyTemplate, url);
  const response = await fetchWithTimeout(targetUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
    }
  }, HTML_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao buscar ${parseHostname(url)}.`);
  }

  return response.text();
}

function buildProxyUrl(proxyTemplate, targetUrl) {
  const trimmed = String(proxyTemplate || "").trim();
  if (!trimmed) {
    return targetUrl;
  }

  if (trimmed.includes("{url}")) {
    return trimmed.replace("{url}", encodeURIComponent(targetUrl));
  }

  const separator = trimmed.includes("?") ? "&" : "?";
  return `${trimmed}${separator}url=${encodeURIComponent(targetUrl)}`;
}

function extractProductImageUrl(html, pageUrl) {
  const candidates = [];
  const cleanedHtml = decodeHtmlEntities(String(html || ""))
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");

  collectJsonLdImages(cleanedHtml, pageUrl, candidates);
  collectMetaImages(cleanedHtml, pageUrl, candidates);
  collectImageTagImages(cleanedHtml, pageUrl, candidates);
  collectUrlImages(cleanedHtml, pageUrl, candidates);
  collectVtexImages(cleanedHtml, pageUrl, candidates);

  return pickBestImage(candidates, pageUrl);
}

function collectJsonLdImages(html, pageUrl, candidates) {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const jsonText = match[1].trim();
    if (!jsonText) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText);
      visitJsonLd(parsed, (item) => {
        const type = normalizeJsonLdType(item["@type"]);
        if (type.includes("PRODUCT") && item.image) {
          for (const image of imageValues(item.image)) {
            addImageCandidate(candidates, image, pageUrl, "jsonld");
          }
        }
      });
    } catch (_error) {
      // Some stores emit invalid JSON-LD. Other extraction strategies handle those pages.
    }
  }
}

function visitJsonLd(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitJsonLd(item, visitor);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  visitor(value);

  if (Array.isArray(value["@graph"])) {
    visitJsonLd(value["@graph"], visitor);
  }
}

function normalizeJsonLdType(type) {
  if (Array.isArray(type)) {
    return type.join(" ").toUpperCase();
  }
  return String(type || "").toUpperCase();
}

function imageValues(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    const values = [];
    for (const item of value) {
      appendItems(values, imageValues(item));
    }
    return values;
  }

  if (typeof value === "object") {
    return imageValues(value.url || value.contentUrl || value["@id"]);
  }

  return [];
}

function collectMetaImages(html, pageUrl, candidates) {
  const metaRegex = /<meta\s+[^>]*>/gi;
  let match;

  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const key = (getAttribute(tag, "property") || getAttribute(tag, "name") || getAttribute(tag, "itemprop") || "").toLowerCase();
    const content = getAttribute(tag, "content");

    if (!content) {
      continue;
    }

    if (["og:image", "og:image:url", "twitter:image", "twitter:image:src", "image", "primaryimageofpage"].includes(key)) {
      addImageCandidate(candidates, content, pageUrl, key.includes("og:") ? "og" : "meta");
    }
  }
}

function collectUrlImages(html, pageUrl, candidates) {
  const urlRegex = /https?:\/\/[^"'<>\\\s]+?\.(?:jpg|jpeg|png|gif|webp)(?:\?[^"'<>\\\s]*)?/gi;
  let match;

  while ((match = urlRegex.exec(html)) !== null) {
    addImageCandidate(candidates, match[0], pageUrl, "url");
  }
}

function collectVtexImages(html, pageUrl, candidates) {
  const vtexRegex = /https?:\/\/[^"'<>\\\s]*(?:vtexassets\.com|\/arquivos\/ids\/|\/arquivos\/)[^"'<>\\\s]*/gi;
  let match;

  while ((match = vtexRegex.exec(html)) !== null) {
    addImageCandidate(candidates, match[0], pageUrl, "vtex");
  }
}

function collectImageTagImages(html, pageUrl, candidates) {
  const imageRegex = /<img\s+[^>]*>/gi;
  let match;

  while ((match = imageRegex.exec(html)) !== null) {
    const tag = match[0];
    const src = getAttribute(tag, "src") || getAttribute(tag, "data-src") || getAttribute(tag, "data-original");
    const srcset = getAttribute(tag, "srcset") || getAttribute(tag, "data-srcset");

    if (src) {
      addImageCandidate(candidates, src, pageUrl, "img");
    }

    if (srcset) {
      const entries = srcset.split(",");
      for (const entry of entries) {
        const url = entry.trim().split(/\s+/)[0];
        if (url) {
          addImageCandidate(candidates, url, pageUrl, "img");
        }
      }
    }
  }
}

function getAttribute(tag, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  if (!match) {
    return "";
  }
  return decodeHtmlEntities(match[2] || match[3] || match[4] || "");
}

function addImageCandidate(candidates, rawUrl, pageUrl, source) {
  const url = cleanImageUrl(normalizeUrl(rawUrl, pageUrl));
  if (!url) {
    return;
  }

  candidates.push({
    url,
    source,
    order: candidates.length,
    score: scoreImageCandidate(url, source, pageUrl)
  });
}

function normalizeUrl(rawUrl, pageUrl) {
  let value = decodeHtmlEntities(String(rawUrl || ""))
    .trim()
    .replace(/^url\((.*)\)$/i, "$1")
    .replace(/^["']|["']$/g, "")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");

  if (!value || value.startsWith("data:")) {
    return "";
  }

  if (value.startsWith("//")) {
    value = `https:${value}`;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (value.charAt(0) === "/") {
    const origin = pageOrigin(pageUrl);
    return origin ? `${origin}${value}` : "";
  }

  const base = pageBaseUrl(pageUrl);
  return base ? `${base}${value}` : "";
}

function cleanImageUrl(url) {
  let value = String(url || "").trim();
  if (!value) {
    return "";
  }

  value = value
    .replace(/^["']|["']$/g, "")
    .replace(/&amp;/g, "&")
    .replace(/[),.;\]]+$/g, "");

  return value;
}

function scoreImageCandidate(url, source, pageUrl) {
  const lower = url.toLowerCase();
  let score = 0;

  if (source === "jsonld") score += 120;
  if (source === "og") score += 100;
  if (source === "meta") score += 70;
  if (source === "img") score += 65;
  if (source === "vtex") score += 60;
  if (source === "url") score += 20;

  if (lower.includes("vtex")) score += 30;
  if (lower.includes("/arquivos/")) score += 30;
  if (lower.includes("/arquivos/ids/")) score += 40;
  if (lower.includes("product") || lower.includes("produto")) score += 15;
  if (lower.includes("sku")) score += 10;

  const candidateHost = parseHostname(url).replace(/^www\./, "");
  const pageHost = parseHostname(pageUrl).replace(/^www\./, "");
  if (candidateHost && pageHost) {
    if (candidateHost === pageHost || candidateHost.endsWith(`.${pageHost}`)) {
      score += 10;
    }
  }

  if (/\b(logo|favicon|sprite|placeholder|banner|brand|payment|selo|icon|social)\b/i.test(lower)) {
    score -= 80;
  }

  if (lower.includes(".webp")) {
    score -= 5;
  }

  return score;
}

function pickBestImage(candidates, pageUrl) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.url)) {
      continue;
    }
    seen.add(candidate.url);
    unique.push(candidate);
  }

  unique.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.order - b.order;
  });

  return unique[0] ? unique[0].url : "";
}

async function applyProducts(products, settings) {
  const root = figma.currentPage.selection[0];
  if (!root) {
    throw new Error("Selecione o frame do e-mail ou da vitrine antes de aplicar.");
  }

  const skuNodes = findSkuNodes(root);
  if (skuNodes.length === 0) {
    throw new Error("Nenhuma camada SKU encontrada. Use nomes como SKU 1, SKU 2, SKU 3...");
  }

  const requested = products.length;
  const limit = Math.min(products.length, skuNodes.length);
  const results = [];

  for (let index = 0; index < limit; index += 1) {
    const product = products[index];
    const skuNode = findSkuNodeForProduct(skuNodes, product, index) || skuNodes[index];
    const itemResult = {
      sku: skuNode.name,
      product: product.title || `Produto ${index + 1}`,
      fields: {},
      errors: []
    };

    if (!product.imageUrl && product.url) {
      try {
        product.imageUrl = await resolveProductImageUrl(product, settings.proxyTemplate || "");
        itemResult.fields.imageResolvedOnApply = Boolean(product.imageUrl);
      } catch (error) {
        itemResult.errors.push(`Falha ao buscar imagem no aplicar: ${readError(error)}`);
      }
    }

    await setProductTextFields(skuNode, product, settings, itemResult);
    await setProductImage(skuNode, product, itemResult);
    results.push(itemResult);
    figma.ui.postMessage({
      type: "apply-progress",
      done: index + 1,
      total: limit,
      item: itemResult
    });
  }

  return {
    requested,
    availableSkus: skuNodes.length,
    applied: limit,
    skipped: Math.max(0, products.length - skuNodes.length),
    results
  };
}

async function resolveProductImageUrl(product, proxyTemplate) {
  if (!product || !product.url) {
    return "";
  }

  const productUrl = String(product.url || "").trim();
  const cacheKey = `${productUrl}|||${proxyTemplate || ""}`;
  if (productImageCache[cacheKey]) {
    return productImageCache[cacheKey];
  }

  if (productImagePendingCache[cacheKey]) {
    return productImagePendingCache[cacheKey];
  }

  productImagePendingCache[cacheKey] = resolveProductImageUrlUncached(productUrl, proxyTemplate, cacheKey);

  try {
    return await productImagePendingCache[cacheKey];
  } finally {
    delete productImagePendingCache[cacheKey];
  }
}

async function resolveProductImageUrlUncached(productUrl, proxyTemplate, cacheKey) {
  const cachedImageUrl = await readPersistentImageCache(productUrl);
  if (cachedImageUrl) {
    productImageCache[cacheKey] = cachedImageUrl;
    return cachedImageUrl;
  }

  const strategies = [
    function () {
      return resolveProductImageFromVtexApi(productUrl);
    },
    function () {
      return resolveProductImageFromHtml(productUrl, proxyTemplate);
    },
    function () {
      return proxyTemplate ? "" : resolveProductImageFromHtml(productUrl, "https://api.allorigins.win/raw?url={url}");
    },
    function () {
      return resolveProductImageFromReader(productUrl);
    }
  ];
  const errors = [];

  for (const strategy of strategies) {
    try {
      const imageUrl = cleanImageUrl(await strategy());
      if (imageUrl) {
        productImageCache[cacheKey] = imageUrl;
        await writePersistentImageCache(productUrl, imageUrl);
        return imageUrl;
      }
    } catch (error) {
      errors.push(readError(error));
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }

  return "";
}

async function readPersistentImageCache(productUrl) {
  if (!figma.clientStorage || typeof figma.clientStorage.getAsync !== "function") {
    return "";
  }

  try {
    return cleanImageUrl(await figma.clientStorage.getAsync(`${PERSISTENT_IMAGE_CACHE_PREFIX}${productUrl}`) || "");
  } catch (_error) {
    return "";
  }
}

async function writePersistentImageCache(productUrl, imageUrl) {
  if (!figma.clientStorage || typeof figma.clientStorage.setAsync !== "function") {
    return;
  }

  try {
    await figma.clientStorage.setAsync(`${PERSISTENT_IMAGE_CACHE_PREFIX}${productUrl}`, imageUrl);
  } catch (_error) {
    // Cache is optional; image application should not fail if storage is unavailable.
  }
}

async function resolveProductImageFromHtml(url, proxyTemplate) {
  const html = await fetchProductHtml(url, proxyTemplate);
  return extractProductImageUrl(html, url) || "";
}

async function resolveProductImageFromVtexApi(url) {
  const endpoints = buildVtexProductApiUrls(url);
  if (endpoints.length === 0) {
    return "";
  }

  try {
    const json = await fetchJson(endpoints[0]);
    const imageUrl = extractVtexImageUrl(json);
    if (imageUrl) {
      return imageUrl;
    }
  } catch (_error) {
    // Try reference-based public VTEX shapes below.
  }

  const fallbackEndpoints = endpoints.slice(1);
  if (fallbackEndpoints.length === 0) {
    return "";
  }

  const fallbackResults = await Promise.all(fallbackEndpoints.map(async function (endpoint) {
    try {
      const json = await fetchJson(endpoint);
      return extractVtexImageUrl(json) || "";
    } catch (_error) {
      return "";
    }
  }));

  for (const imageUrl of fallbackResults) {
    if (imageUrl) {
      return imageUrl;
    }
  }

  return "";
}

async function resolveProductImageFromReader(url) {
  const readerUrl = `https://r.jina.ai/${url}`;
  const response = await fetchWithTimeout(readerUrl, {
    method: "GET",
    headers: {
      Accept: "text/plain,*/*;q=0.8",
      "x-with-images-summary": "all",
      "x-retain-images": "all"
    }
  }, READER_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao buscar fallback reader.`);
  }

  const text = await response.text();
  return extractProductImageUrl(text, url) || "";
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      Accept: "application/json,text/plain,*/*;q=0.8"
    }
  }, JSON_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} em ${url}.`);
  }

  const text = await response.text();
  return JSON.parse(text);
}

function buildVtexProductApiUrls(url) {
  const origin = pageOrigin(url);
  const slug = productSlugFromUrl(url);
  const reference = productReferenceFromUrl(url);
  const endpoints = [];

  if (!origin) {
    return endpoints;
  }

  if (slug) {
    endpoints.push(`${origin}/api/catalog_system/pub/products/search/${encodeURIComponent(slug)}`);
  }

  if (reference) {
    endpoints.push(`${origin}/api/catalog_system/pub/products/search?fq=alternateIds_RefId:${encodeURIComponent(reference)}`);
    endpoints.push(`${origin}/api/catalog_system/pub/products/search?fq=skuReference:${encodeURIComponent(reference)}`);
    endpoints.push(`${origin}/api/catalog_system/pub/products/search?fq=productReference:${encodeURIComponent(reference)}`);
    endpoints.push(`${origin}/api/catalog_system/pub/products/search?fq=referenceId:${encodeURIComponent(reference)}`);
  }

  return endpoints;
}

function productSlugFromUrl(url) {
  const path = urlPath(url);
  const match = path.match(/\/([^\/?#]+)\/p(?:$|[?#])/i) || path.match(/\/([^\/?#]+)\/p$/i);
  return match ? decodeURIComponentSafe(match[1]) : "";
}

function productReferenceFromUrl(url) {
  const path = urlPath(url);
  const match = path.match(/([a-z0-9]+-\d+-\d+)(?:\/p|$|[?#])/i);
  return match ? match[1] : "";
}

function urlPath(url) {
  const match = String(url || "").match(/^https?:\/\/[^\/?#]+([^?#]*)/i);
  return match ? match[1] : "";
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function extractVtexImageUrl(json) {
  const products = Array.isArray(json) ? json : [json];
  const candidates = [];

  for (const product of products) {
    if (!product || !Array.isArray(product.items)) {
      continue;
    }

    for (const item of product.items) {
      if (!item || !Array.isArray(item.images)) {
        continue;
      }

      for (let index = 0; index < item.images.length; index += 1) {
        const image = item.images[index];
        const imageUrl = image && cleanImageUrl(image.imageUrl || image.imageUrl2 || image.url);
        if (!imageUrl) {
          continue;
        }

        candidates.push({
          url: imageUrl,
          order: candidates.length,
          score: scoreVtexApiImage(image, index)
        });
      }
    }
  }

  candidates.sort(function (a, b) {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.order - b.order;
  });

  return candidates[0] ? candidates[0].url : "";
}

function scoreVtexApiImage(image, index) {
  const label = normalizeLayerName(`${image.imageLabel || ""} ${image.imageText || ""}`);
  let score = 100 - index;

  if (label.indexOf("PRINCIPAL") >= 0) {
    score += 100;
  }

  if (label.indexOf("LATERAL") >= 0) {
    score += 70;
  }

  if (label.indexOf("FRENTE") >= 0 || label.indexOf("FRONTAL") >= 0) {
    score += 30;
  }

  if (label.indexOf("LOGO") >= 0 || label.indexOf("ICONE") >= 0) {
    score -= 80;
  }

  return score;
}

async function setProductTextFields(skuNode, product, settings, itemResult) {
  const title = product.title;
  const cta = product.cta;
  const discount = formatDiscount(product.discount);

  itemResult.fields.discount = await setNamedText(skuNode, FIELD_ALIASES.discount, discount || "");
  itemResult.fields.title = await setNamedText(skuNode, FIELD_ALIASES.title, title || "");
  itemResult.fields.installmentCount = await setNamedText(skuNode, FIELD_ALIASES.installmentCount, product.installmentCount || "");
  itemResult.fields.installmentValue = await setNamedText(skuNode, FIELD_ALIASES.installmentValue, product.installmentValue || "");
  itemResult.fields.cashPrice = await setNamedText(skuNode, FIELD_ALIASES.cashPrice, product.cashPrice || product.price || "");
  itemResult.fields.cta = await setNamedText(skuNode, FIELD_ALIASES.cta, cta || "");
}

async function setProductImage(skuNode, product, itemResult) {
  product.imageUrl = cleanImageUrl(product.imageUrl);

  if (!product.imageUrl) {
    itemResult.fields.image = false;
    return;
  }

  const imageLayer = findImageLayer(skuNode);
  if (!imageLayer) {
    itemResult.fields.image = false;
    itemResult.errors.push("Camada IMG nao encontrada.");
    return;
  }

  const target = findFillTarget(imageLayer);
  if (!target) {
    itemResult.fields.image = false;
    itemResult.errors.push("Camada IMG nao aceita fill de imagem.");
    return;
  }

  try {
    const image = await createFigmaImageFromUrl(product.imageUrl);
    const imageScaleMode = productNeedsFitImage(product) ? "FIT" : "FILL";
    const imageFill = {
      type: "IMAGE",
      imageHash: image.hash,
      scaleMode: imageScaleMode
    };

    if (imageScaleMode === "FIT") {
      target.fills = [
        {
          type: "SOLID",
          color: { r: 1, g: 1, b: 1 }
        },
        imageFill
      ];
    } else {
      target.fills = [imageFill];
    }

    itemResult.fields.image = true;
    itemResult.fields.imageScaleMode = imageScaleMode;
  } catch (error) {
    itemResult.fields.image = false;
    itemResult.errors.push(`Falha ao aplicar imagem: ${error && error.message ? error.message : String(error)}`);
  }
}

function productNeedsFitImage(product) {
  const text = normalizeLayerName(`${product && product.title ? product.title : ""} ${product && product.url ? product.url : ""}`);
  return text.indexOf("BLUSAO") >= 0 ||
    text.indexOf("BLUSA") >= 0 ||
    text.indexOf("JAQUETA") >= 0 ||
    text.indexOf("CALCA") >= 0;
}

function findSkuNodes(root) {
  const searchRoots = findProductSearchRoots(root);
  const nodes = [];

  for (const searchRoot of searchRoots) {
    collectSkuNodes(searchRoot, nodes);
  }

  if (nodes.length === 0 && searchRoots[0] !== root) {
    collectSkuNodes(root, nodes);
  }

  const unique = [];
  const seen = new Set();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    if (looksLikeProductCard(node)) {
      unique.push(node);
    }
  }

  if (unique.length === 0) {
    for (const node of nodes) {
      if (seen.has(`fallback-${node.id}`)) {
        continue;
      }
      seen.add(`fallback-${node.id}`);
      unique.push(node);
    }
  }

  unique.sort(compareSkuNodes);
  return unique;
}

function findSkuNodeForProduct(skuNodes, product, fallbackIndex) {
  const expectedNumber = Number(product && product.index ? product.index : fallbackIndex + 1);
  if (!Number.isFinite(expectedNumber)) {
    return null;
  }

  return skuNodes.find((node) => skuNumber(node.name) === expectedNumber) || null;
}

function collectSkuNodes(root, nodes) {
  if (isSkuNode(root)) {
    nodes.push(root);
  }

  if (typeof root.findAll === "function") {
    appendItems(nodes, root.findAll(isSkuNode));
  }
}

function findProductSearchRoots(root) {
  const scopes = [];

  if (isProductScope(root)) {
    scopes.push(root);
  }

  if (typeof root.findAll === "function") {
    appendItems(scopes, root.findAll(isProductScope));
  }

  const scopesWithSkus = [];
  for (const scope of scopes) {
    if (hasSkuDescendant(scope)) {
      scopesWithSkus.push(scope);
    }
  }

  scopesWithSkus.sort(compareVisualNodes);
  return scopesWithSkus.length > 0 ? scopesWithSkus : [root];
}

function isProductScope(node) {
  if (typeof node.findAll !== "function") {
    return false;
  }

  const name = normalizeLayerName(node.name);
  return name === "CORPO" ||
    name === "VITRINE" ||
    name === "VITRINES" ||
    name === "PRODUTOS" ||
    name === "PRODUCTS" ||
    name.indexOf("VITRINE") >= 0;
}

function hasSkuDescendant(node) {
  if (isSkuNode(node)) {
    return true;
  }

  if (typeof node.findOne === "function") {
    return Boolean(node.findOne(isSkuNode));
  }

  return false;
}

function looksLikeProductCard(node) {
  return Boolean(
    findImageLayer(node) &&
    findNamedNode(node, FIELD_ALIASES.title) &&
    findNamedNode(node, FIELD_ALIASES.cashPrice) &&
    findNamedNode(node, FIELD_ALIASES.cta)
  );
}

function compareVisualNodes(a, b) {
  const aBox = getNodeBounds(a);
  const bBox = getNodeBounds(b);
  const rowTolerance = Math.max(8, Math.min(aBox.height || 0, bBox.height || 0) * 0.2);

  if (Math.abs(aBox.y - bBox.y) > rowTolerance) {
    return aBox.y - bBox.y;
  }

  if (aBox.x !== bBox.x) {
    return aBox.x - bBox.x;
  }

  return skuNumber(a.name) - skuNumber(b.name);
}

function compareSkuNodes(a, b) {
  const aNumber = skuNumber(a.name);
  const bNumber = skuNumber(b.name);

  if (aNumber !== bNumber) {
    return aNumber - bNumber;
  }

  return compareVisualNodes(a, b);
}

function isSkuNode(node) {
  return /^SKU\s*\d+\b/i.test(normalizeLayerName(node.name));
}

function skuNumber(name) {
  const match = normalizeLayerName(name).match(/^SKU\s*(\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function setNamedText(root, aliases, value) {
  const namedNode = findNamedNode(root, aliases);
  if (!namedNode) {
    return false;
  }

  const textNode = namedNode.type === "TEXT" ? namedNode : findFirstTextNode(namedNode);
  if (!textNode) {
    return false;
  }

  return setTextNodeCharacters(textNode, value);
}

async function setTextNodeCharacters(textNode, value) {
  await loadFontsForTextNode(textNode);
  textNode.characters = String(value || "");
  return true;
}

function findNamedNode(root, aliases) {
  const normalizedAliases = aliases.map(normalizeLayerName);
  const candidates = [];

  if (typeof root.findAll === "function") {
    appendItems(candidates, root.findAll((node) => {
      const name = normalizeLayerName(node.name);
      return normalizedAliases.includes(name);
    }));
  }

  return candidates[0] || null;
}

function findFirstTextNode(root) {
  if (root.type === "TEXT") {
    return root;
  }

  if (typeof root.findOne === "function") {
    return root.findOne((node) => node.type === "TEXT");
  }

  return null;
}

function findFillTarget(root) {
  if (canSetFills(root)) {
    return root;
  }

  if (typeof root.findOne === "function") {
    return root.findOne(canSetFills);
  }

  return null;
}

function findImageLayer(root) {
  const namedNode = findNamedNode(root, FIELD_ALIASES.image);
  if (namedNode) {
    return namedNode;
  }

  return null;
}

function compareTopLeft(a, b) {
  const aBox = getNodeBounds(a);
  const bBox = getNodeBounds(b);
  const aY = aBox.y;
  const bY = bBox.y;
  if (aY !== bY) {
    return aY - bY;
  }

  const aX = aBox.x;
  const bX = bBox.x;
  return aX - bX;
}

function getNodeBounds(node) {
  const box = node.absoluteBoundingBox || {};
  return {
    x: typeof box.x === "number" ? box.x : (typeof node.x === "number" ? node.x : 0),
    y: typeof box.y === "number" ? box.y : (typeof node.y === "number" ? node.y : 0),
    width: typeof box.width === "number" ? box.width : (typeof node.width === "number" ? node.width : 0),
    height: typeof box.height === "number" ? box.height : (typeof node.height === "number" ? node.height : 0)
  };
}

function canSetFills(node) {
  return "fills" in node && Array.isArray(node.fills);
}

function hasImageFill(node) {
  if (!canSetFills(node)) {
    return false;
  }

  for (const fill of node.fills) {
    if (fill && fill.type === "IMAGE") {
      return true;
    }
  }

  return false;
}

async function loadFontsForTextNode(textNode) {
  const fonts = [];

  if (textNode.characters.length > 0 && typeof textNode.getRangeAllFontNames === "function") {
    try {
      appendItems(fonts, textNode.getRangeAllFontNames(0, textNode.characters.length));
    } catch (_error) {
      // Fall back to fontName below.
    }
  }

  if (textNode.fontName && textNode.fontName !== figma.mixed) {
    fonts.push(textNode.fontName);
  }

  const uniqueFonts = [];
  const seen = new Set();
  for (const font of fonts) {
    if (!font || font === figma.mixed) {
      continue;
    }

    const key = `${font.family}|||${font.style}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueFonts.push(font);
  }

  if (uniqueFonts.length === 0) {
    const fallback = { family: "Inter", style: "Regular" };
    await figma.loadFontAsync(fallback);
    textNode.fontName = fallback;
    return;
  }

  for (const font of uniqueFonts) {
    await figma.loadFontAsync(font);
  }
}

async function createFigmaImageFromUrl(url) {
  const candidates = buildImageDownloadCandidates(url);
  const errors = [];

  for (const candidate of candidates) {
    if (figmaImageHashCache[candidate]) {
      return { hash: figmaImageHashCache[candidate] };
    }
  }

  if (typeof figma.createImageAsync === "function") {
    for (const candidate of candidates) {
      try {
        const image = await figma.createImageAsync(candidate);
        cacheFigmaImageHash(candidates, image.hash);
        return image;
      } catch (error) {
        errors.push(`${candidate}: ${readError(error)}`);
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const response = await fetchWithTimeout(candidate, {}, IMAGE_DOWNLOAD_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ao baixar imagem.`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const image = figma.createImage(bytes);
      cacheFigmaImageHash(candidates, image.hash);
      return image;
    } catch (error) {
      errors.push(`${candidate}: ${readError(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }

  throw new Error("URL de imagem vazia.");
}

function cacheFigmaImageHash(urls, hash) {
  for (const url of urls) {
    figmaImageHashCache[url] = hash;
  }
}

function buildImageDownloadCandidates(url) {
  const candidates = [];
  const seen = {};

  addImageDownloadCandidate(candidates, seen, url);

  const cleaned = cleanImageUrl(url);
  addImageDownloadCandidate(candidates, seen, cleaned);
  addImageDownloadCandidate(candidates, seen, removeUrlQueryAndHash(cleaned));

  if (/vtexassets\.com|\/arquivos\/ids\//i.test(cleaned)) {
    addImageDownloadCandidate(candidates, seen, cleaned.replace(/(\/ids\/\d+)-\d+-auto(?=([?#/]|$))/i, "$1"));
    addImageDownloadCandidate(candidates, seen, removeUrlQueryAndHash(cleaned).replace(/(\/ids\/\d+)-\d+-auto$/i, "$1"));
  }

  return candidates;
}

function addImageDownloadCandidate(candidates, seen, url) {
  const value = cleanImageUrl(url);
  if (!value || seen[value]) {
    return;
  }

  seen[value] = true;
  candidates.push(value);
}

function removeUrlQueryAndHash(url) {
  return String(url || "").split(/[?#]/)[0];
}

function fetchWithTimeout(url, options, timeoutMs) {
  if (typeof AbortController === "undefined") {
    return fetch(url, options || {});
  }

  const controller = new AbortController();
  const requestOptions = options || {};
  requestOptions.signal = controller.signal;

  const timeout = setTimeout(function () {
    controller.abort();
  }, timeoutMs);

  return fetch(url, requestOptions).then(function (response) {
    clearTimeout(timeout);
    return response;
  }, function (error) {
    clearTimeout(timeout);
    throw error;
  });
}

function formatDiscount(discount) {
  const value = String(discount || "").trim();
  if (!value) {
    return "";
  }

  const match = value.match(/(\d{1,3})\s*%/);
  if (!match) {
    return value;
  }

  return `${Number(match[1])}%`;
}

function normalizeLayerName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/");
}

function parseHostname(url) {
  const match = String(url || "").match(/^https?:\/\/([^\/?#]+)/i);
  return match ? match[1] : "";
}

function pageOrigin(url) {
  const match = String(url || "").match(/^(https?:\/\/[^\/?#]+)/i);
  return match ? match[1] : "";
}

function pageBaseUrl(url) {
  const origin = pageOrigin(url);
  if (!origin) {
    return "";
  }

  const withoutQuery = String(url || "").split(/[?#]/)[0];
  const path = withoutQuery.slice(origin.length);
  const slashIndex = path.lastIndexOf("/");
  const dir = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "/";
  return `${origin}${dir}`;
}

function readError(error) {
  return error && error.message ? error.message : String(error);
}

function appendItems(target, items) {
  if (!items) {
    return target;
  }

  for (const item of items) {
    target.push(item);
  }

  return target;
}

function uniqueNodes(nodes) {
  const unique = [];
  const seen = new Set();

  for (const node of nodes) {
    if (!node || seen.has(node.id)) {
      continue;
    }

    seen.add(node.id);
    unique.push(node);
  }

  return unique;
}

function cloneProduct(product) {
  const clone = {};
  const source = product || {};

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      clone[key] = source[key];
    }
  }

  return clone;
}
