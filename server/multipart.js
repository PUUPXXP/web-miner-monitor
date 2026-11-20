// 零依赖 multipart/form-data 解析（用于控制台上传升级包）
// 只支持：普通字段 + 文件；文件落在临时目录，调用方负责清理
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('上传内容过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 从 Content-Disposition 头中取参数：name="xxx" / filename="yyy" */
function dispositionParam(head, key) {
  const re = new RegExp(key + '="([^"]*)"', 'i');
  const m = re.exec(head);
  return m ? m[1] : null;
}

/**
 * @returns {Promise<{fields:Object, files:Array<{name:string, filename:string, path:string, size:number}>}>}
 */
export async function readMultipart(req, limit = 100 * 1024 * 1024) {
  const type = String(req.headers['content-type'] || '');
  const bm = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!bm) throw new Error('缺少 multipart boundary');
  const boundary = (bm[1] || bm[2] || '').trim();
  const body = await readRaw(req, limit);
  const result = { fields: {}, files: [] };

  // 规范化为「\r\n--boundary」开头，便于统一处理分隔符
  const text = Buffer.concat([Buffer.from('\r\n'), body]);
  const delim = Buffer.from('\r\n--' + boundary);
  const cursor = { pos: 0 };

  for (;;) {
    const d = text.indexOf(delim, cursor.pos);
    if (d < 0) break;
    let p = d + delim.length;
    // 结束标记 --boundary--
    if (text[p] === 0x2d && text[p + 1] === 0x2d) break;
    // 跳过 CRLF
    if (text[p] === 0x0d && text[p + 1] === 0x0a) p += 2;
    else break;

    const headEnd = text.indexOf(Buffer.from('\r\n\r\n'), p);
    if (headEnd < 0) break;
    const head = text.subarray(p, headEnd).toString('utf8');
    const dataStart = headEnd + 4;
    const nextDelim = text.indexOf(delim, dataStart);
    if (nextDelim < 0) break;
    const data = text.subarray(dataStart, nextDelim);

    const name = dispositionParam(head, 'name');
    const filename = dispositionParam(head, 'filename');
    if (filename) {
      const tmp = path.join(os.tmpdir(), `mm-upload-${crypto.randomBytes(6).toString('hex')}`);
      fs.writeFileSync(tmp, data);
      result.files.push({ name, filename, path: tmp, size: data.length });
    } else if (name) {
      result.fields[name] = data.toString('utf8');
    }
    cursor.pos = nextDelim;
  }
  return result;
}
