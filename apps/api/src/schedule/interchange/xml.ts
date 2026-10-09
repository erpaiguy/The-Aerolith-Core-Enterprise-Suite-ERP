// A small XML tree for reading MS Project XML (saxes, ISC, already installed with exceljs). Elements keep their name
// without namespace prefix, their attributes, their text and their children; enough for a data file, no more.
import { SaxesParser } from 'saxes';

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

export function parseXml(xml: string): XmlNode {
  const parser = new SaxesParser({ xmlns: false });
  const root: XmlNode = { name: '#root', attrs: {}, text: '', children: [] };
  const stack: XmlNode[] = [root];
  parser.on('opentag', (tag) => {
    const node: XmlNode = {
      name: tag.name.replace(/^.*:/, ''),
      attrs: Object.fromEntries(Object.entries(tag.attributes).map(([k, v]) => [k, String(v)])),
      text: '',
      children: [],
    };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on('text', (t) => {
    stack.at(-1)!.text += t;
  });
  parser.on('cdata', (t) => {
    stack.at(-1)!.text += t;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.write(xml).close();
  const top = root.children[0];
  if (!top) throw new Error('empty XML');
  return top;
}

export const child = (n: XmlNode | undefined, name: string) =>
  n?.children.find((c) => c.name === name);
export const children = (n: XmlNode | undefined, name: string) =>
  n?.children.filter((c) => c.name === name) ?? [];
export const text = (n: XmlNode | undefined, name: string) => child(n, name)?.text.trim() ?? '';

export const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
