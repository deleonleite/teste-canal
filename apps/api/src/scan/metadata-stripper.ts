import { PDFDocument, type PDFDict, PDFName } from 'pdf-lib';
import JSZip from 'jszip';

/** Remoção de metadados que podem identificar o denunciante (EXIF/GPS, autor, empresa, comentários). */

function stripJpeg(b: Buffer): Buffer {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('JPEG inválido');
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error('JPEG malformado');
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) {
      out.push(b.subarray(i));
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0x00) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xda) {
      // Início do scan: copia o cabeçalho e os dados entropy-coded até o próximo marcador real.
      let j = i + 2 + len;
      while (j < b.length) {
        if (b[j] === 0xff) {
          const n = b[j + 1]!;
          if (n !== 0x00 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) break;
        }
        j++;
      }
      out.push(b.subarray(i, j));
      i = j;
      continue;
    }
    // Descarta APP1..APP15 (EXIF, XMP, IPTC, ICC…) exceto Adobe (0xEE, necessário à cor) e comentários.
    const drop = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return Buffer.concat(out);
}

const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT',
]);

function stripPng(b: Buffer): Buffer {
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG inválido');
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > b.length) throw new Error('PNG malformado');
    // tEXt/zTXt/iTXt/eXIf/tIME e qualquer chunk auxiliar desconhecido saem; os CRCs seguem válidos.
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
  }
  return Buffer.concat(out);
}

function skipSubBlocks(b: Buffer, i: number): number {
  while (i < b.length && b[i] !== 0) i += b[i]! + 1;
  return i + 1;
}

function stripGif(b: Buffer): Buffer {
  const head = b.subarray(0, 6).toString('latin1');
  if (head !== 'GIF87a' && head !== 'GIF89a') throw new Error('GIF inválido');
  const out: Buffer[] = [];
  let i = 13;
  if (b[10]! & 0x80) i += 3 * (1 << ((b[10]! & 7) + 1));
  out.push(b.subarray(0, i));
  while (i < b.length) {
    const tag = b[i]!;
    if (tag === 0x3b) {
      out.push(b.subarray(i, i + 1));
      break;
    }
    if (tag === 0x21) {
      const label = b[i + 1]!;
      const end = skipSubBlocks(b, i + 2);
      // Mantém controle gráfico e o laço NETSCAPE; descarta comentários e demais extensões.
      const keep =
        label === 0xf9 || (label === 0xff && b.subarray(i + 3, i + 14).toString('latin1') === 'NETSCAPE2.0');
      if (keep) out.push(b.subarray(i, end));
      i = end;
    } else if (tag === 0x2c) {
      let j = i + 10;
      if (b[i + 9]! & 0x80) j += 3 * (1 << ((b[i + 9]! & 7) + 1));
      j = skipSubBlocks(b, j + 1);
      out.push(b.subarray(i, j));
      i = j;
    } else {
      throw new Error('GIF malformado');
    }
  }
  return Buffer.concat(out);
}

async function stripPdf(b: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.load(b, { updateMetadata: false });
  const info = (doc as unknown as { getInfoDict(): PDFDict }).getInfoDict(); // API pública em runtime, privada nos tipos
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
    info.delete(PDFName.of(k));
  }
  doc.catalog.delete(PDFName.of('Metadata')); // XMP
  return Buffer.from(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
}

const EMPTY_CORE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>';
const EMPTY_APP =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"/>';

/** ZIP/DOCX: zera propriedades do documento, autores de comentários/revisões e datas das entradas. */
async function stripZip(b: Buffer, isDocx: boolean): Promise<Buffer> {
  const zip = await JSZip.loadAsync(b);
  const out = new JSZip();
  const epoch = new Date(Date.UTC(1980, 0, 1));
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (isDocx && name === 'docProps/core.xml') {
      out.file(name, EMPTY_CORE, { date: epoch });
    } else if (isDocx && name === 'docProps/app.xml') {
      out.file(name, EMPTY_APP, { date: epoch });
    } else if (isDocx && (name === 'docProps/custom.xml' || name.startsWith('docProps/thumbnail'))) {
      continue;
    } else if (isDocx && /^word\/.*\.xml$/.test(name)) {
      const xml = (await entry.async('string')).replace(/\sw:(author|initials)="[^"]*"/g, ' w:$1=""');
      out.file(name, xml, { date: epoch });
    } else {
      out.file(name, await entry.async('nodebuffer'), { date: epoch });
    }
  }
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment: '' });
}

/** Tipos cuja limpeza é suportada. `.doc` (OLE) não é limpável: é recusado em denúncia anônima. */
export const STRIPPABLE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'pdf', 'docx', 'zip']);

/** Devolve o arquivo sem metadados, ou lança se o conteúdo for inválido/ilegível. */
export async function stripMetadata(extension: string, body: Buffer): Promise<Buffer> {
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return stripJpeg(body);
    case 'png':
      return stripPng(body);
    case 'gif':
      return stripGif(body);
    case 'pdf':
      return stripPdf(body);
    case 'docx':
      return stripZip(body, true);
    case 'zip':
      return stripZip(body, false);
    default:
      throw new Error(`Sem suporte à limpeza de .${extension}`);
  }
}

const MAX_ENTRIES = 1000;
const MAX_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_RATIO = 100;
const NESTED = /\.(zip|jar|rar|7z|gz|tgz|bz2|xz|tar|cab|iso)$/i;

/** Barra zip-bomb e arquivos compactados aninhados (lê só o diretório central). */
export async function inspectArchive(body: Buffer): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(body);
  } catch {
    throw new Error('Arquivo compactado inválido ou corrompido');
  }
  const entries = Object.entries(zip.files).filter(([, e]) => !e.dir);
  if (entries.length > MAX_ENTRIES) throw new Error('Arquivo compactado com entradas demais');
  let total = 0;
  for (const [name, e] of entries) {
    if (NESTED.test(name)) throw new Error('Arquivos compactados aninhados não são permitidos');
    total += (e as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize ?? 0;
  }
  if (total > MAX_UNCOMPRESSED || total > Math.max(body.length, 1) * MAX_RATIO) {
    throw new Error('Arquivo compactado com taxa de compressão suspeita (zip-bomb)');
  }
}
