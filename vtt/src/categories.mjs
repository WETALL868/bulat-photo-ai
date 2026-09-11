/*
  Дерево категорий VTT и детерминированная раскладка товаров по нему.

  Стабильность важнее красоты. Ключ категории — это её собственный Id из
  VTT, а не позиция в списке и не слаг от названия: поставщик вправе
  переименовать раздел, и при завязке на название у всех его товаров
  «сменилась» бы категория, а ссылки на сайте протухли бы. Слаг считается
  от Id и остаётся прежним при любом переименовании.

  Источников раскладки два, и они упорядочены.

  1. GetCategories — если операция доступна учётной записи. Тогда у нас есть
     настоящая иерархия с ParentId, и товар кладётся в тот лист, чей Id
     он называет.
  2. Поля Group и RootGroup самого товара. Они есть всегда, и по ним
     строится плоское дерево «RootGroup → Group». Это запасной путь, и он
     честно помечается в отчёте как производный.

  Ничего не угадывается. Товар, для которого категорию определить нельзя,
  не расползается по похожим разделам и не попадает в «Прочее» молча: он
  уходит в отчёт как unmapped, а на витрине показывается в разделе
  «Без категории», который видно и который стыдно оставить.
*/
import { asText, slugify } from './normalize.mjs';

const ID_KEYS = ['Id', 'ID', 'CategoryId', 'GroupId'];
const NAME_KEYS = ['Name', 'CategoryName', 'GroupName', 'Title'];
const PARENT_KEYS = ['ParentId', 'ParentID', 'Parent', 'ParentCategoryId'];

function pick(raw, keys) {
  for (const k of keys) if (raw?.[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
  return undefined;
}

export const UNMAPPED_ID = '__unmapped__';

/* Корень обозначается по-разному: отсутствующий ParentId, ноль, пустая
   строка, GUID из нулей. Все эти написания значат одно и то же. */
function isRootParent(value) {
  if (value === undefined || value === null) return true;
  const s = String(value).trim();
  return s === '' || s === '0' || /^0{8}-?0{4}-?0{4}-?0{4}-?0{12}$/i.test(s);
}

export function buildCategoryTree(rawCategories = []) {
  const nodes = new Map();
  const issues = [];

  for (const raw of rawCategories) {
    const id = asText(pick(raw, ID_KEYS));
    const name = asText(pick(raw, NAME_KEYS));
    if (!id) { issues.push({ kind: 'category-without-id', name: name ?? null }); continue; }
    if (nodes.has(id)) { issues.push({ kind: 'duplicate-category-id', id, name: name ?? null }); continue; }
    const parentRaw = pick(raw, PARENT_KEYS);
    nodes.set(id, {
      id,
      name: name ?? id,
      parentId: isRootParent(parentRaw) ? null : asText(parentRaw),
      slug: slugify(`${name ?? ''}-${id}`) || slugify(id),
      children: [],
      raw,
    });
  }

  /* Родитель, которого нет в выгрузке, не должен уронить дерево: узел
     становится корневым, а факт уходит в отчёт. */
  for (const node of nodes.values()) {
    if (node.parentId && !nodes.has(node.parentId)) {
      issues.push({ kind: 'missing-parent', id: node.id, parentId: node.parentId });
      node.parentId = null;
    }
  }

  /* Цикл в иерархии — редкость, но он вешает обход намертво, поэтому
     проверяется явно и разрывается у виновного узла. */
  for (const node of nodes.values()) {
    const seen = new Set([node.id]);
    let cur = node.parentId ? nodes.get(node.parentId) : null;
    while (cur) {
      if (seen.has(cur.id)) {
        issues.push({ kind: 'category-cycle', id: node.id, at: cur.id });
        node.parentId = null;
        break;
      }
      seen.add(cur.id);
      cur = cur.parentId ? nodes.get(cur.parentId) : null;
    }
  }

  const roots = [];
  for (const node of nodes.values()) {
    if (node.parentId) nodes.get(node.parentId).children.push(node);
    else roots.push(node);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
  roots.sort(byName);
  for (const node of nodes.values()) node.children.sort(byName);

  return { nodes, roots, issues, source: 'GetCategories' };
}

/* Запасное дерево из полей самого товара: RootGroup → Group. Идентификатор
   синтетический и помечен префиксом, чтобы его нельзя было спутать с
   настоящим Id из VTT. */
export function deriveCategoryTree(items = []) {
  const nodes = new Map();
  const ensure = (key, name, parentId) => {
    if (!nodes.has(key)) {
      nodes.set(key, { id: key, name, parentId, slug: slugify(name) || slugify(key), children: [], derived: true });
    }
    return nodes.get(key);
  };
  for (const item of items) {
    const root = asText(item.categoryRoot);
    const leaf = asText(item.category);
    if (!root && !leaf) continue;
    const rootKey = root ? `g:${slugify(root)}` : null;
    if (rootKey) ensure(rootKey, root, null);
    if (leaf) ensure(`g:${slugify(root || '')}:${slugify(leaf)}`, leaf, rootKey);
  }
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).children.push(node);
    else { node.parentId = null; roots.push(node); }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
  roots.sort(byName);
  for (const node of nodes.values()) node.children.sort(byName);
  return { nodes, roots, issues: [], source: 'ItemDto.Group/RootGroup' };
}

/*
  Идентификатор производной категории считается из полей самого товара и ни
  от чего больше не зависит. Это нужно для потоковой выгрузки: категорию
  товара можно определить сразу, не дожидаясь конца каталога, — иначе
  возобновление после сбоя пришлось бы начинать заново.
*/
export function derivedCategoryIdFor(item) {
  const root = asText(item.categoryRoot);
  const leaf = asText(item.category);
  if (leaf) return `g:${slugify(root || '')}:${slugify(leaf)}`;
  if (root) return `g:${slugify(root)}`;
  return null;
}

/*
  Пораздельный маппер: одна и та же логика применяется и к порции на лету,
  и к целому набору в тестах. Возвращает решение по одному товару, чтобы
  выгрузка не держала весь каталог в памяти.
*/
export function createCategoryMapper(tree) {
  const byId = tree.nodes;
  const byName = new Map();
  for (const node of byId.values()) {
    const key = node.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(node);
  }
  const derived = tree.source !== 'GetCategories';

  return function assign(item) {
    if (derived) {
      const id = derivedCategoryIdFor(item);
      return id ? { id, status: 'derived' } : { id: UNMAPPED_ID, status: 'unmapped' };
    }
    let ambiguous = null;
    /* Порядок попыток: присланный поставщиком Id раздела, затем уже
       проставленная категория, затем названия. Id надёжнее названия, а
       название — единственное, что есть, когда Id не прислали. */
    for (const raw of [item.groupId, item.categoryId, item.category, item.categoryRoot]) {
      const value = asText(raw);
      if (!value) continue;
      if (byId.has(value)) return { id: value, status: 'byId' };
      const named = byName.get(value.toLowerCase());
      if (named?.length === 1) return { id: named[0].id, status: 'byName' };
      if (named?.length > 1) ambiguous = { value, candidates: named.map((n) => n.id) };
    }
    return ambiguous
      ? { id: UNMAPPED_ID, status: 'ambiguous', ...ambiguous }
      : { id: UNMAPPED_ID, status: 'unmapped' };
  };
}

export function pathOf(tree, id) {
  const out = [];
  let cur = tree.nodes.get(id);
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : null;
  }
  return out;
}

/*
  Раскладка товара по дереву. Порядок попыток фиксирован и одинаков от
  запуска к запуску — от этого зависит, не «переедет» ли товар между
  сборками при тех же данных.

  Совпадение по названию разрешается только когда имя категории уникально
  в дереве. Если одинаковых имён несколько, это неоднозначность: товар
  уходит в отчёт, а не в первый попавшийся раздел.
*/
export function mapItemsToCategories(items, tree) {
  const assign = createCategoryMapper(tree);
  const assigned = new Map();
  const report = { mapped: 0, unmapped: [], ambiguous: [], byNameFallback: 0 };
  for (const item of items) {
    const res = assign(item);
    assigned.set(item.id, res.id);
    if (res.status === 'byName') report.byNameFallback += 1;
    if (res.status === 'ambiguous') {
      report.ambiguous.push({ id: item.id, name: item.name ?? null, value: res.value, candidates: res.candidates });
    }
    if (res.id === UNMAPPED_ID) {
      report.unmapped.push({ id: item.id, name: item.name ?? null, group: item.category ?? null, rootGroup: item.categoryRoot ?? null });
    } else {
      report.mapped += 1;
    }
  }
  return { assigned, report };
}

/* Плоское представление для витрины: путь, уровень и счётчик товаров. */
export function flattenTree(tree, assigned = new Map()) {
  const counts = new Map();
  for (const catId of assigned.values()) counts.set(catId, (counts.get(catId) ?? 0) + 1);

  const out = [];
  const walk = (node, depth) => {
    const path = pathOf(tree, node.id);
    out.push({
      id: node.id,
      name: node.name,
      slug: node.slug,
      parentId: node.parentId,
      depth,
      leaf: node.children.length === 0,
      path: path.map((n) => n.name),
      count: counts.get(node.id) ?? 0,
      derived: Boolean(node.derived),
    });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of tree.roots) walk(root, 0);

  if (counts.has(UNMAPPED_ID)) {
    out.push({
      id: UNMAPPED_ID, name: 'Без категории', slug: 'bez-kategorii', parentId: null,
      depth: 0, leaf: true, path: ['Без категории'], count: counts.get(UNMAPPED_ID), derived: true,
    });
  }
  return out;
}
