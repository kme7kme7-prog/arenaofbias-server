// Real 3×2 RGB images generated once with Pillow; runtime tests use only Node.
export const referencePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGM0TpvJAAZMEIqBgQEAFVoBNiQnPo4AAAAASUVORK5CYII=', 'base64');
export const referenceJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnKKKK948Q/9k=', 'base64');
export const referenceWebp = Buffer.from('UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoDAAIAAUAmJaACdLoB+AAETAAA/u+9V/43bjDfgu/33oDeBgAAAA==', 'base64');

function pngChunk(type, data) {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
  let crc = 0xffffffff;
  for (const value of result.subarray(4, -4)) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function jpegSegment(marker, text) {
  const data = Buffer.from(text), header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(data.length + 2, 2); return Buffer.concat([header, data]);
}
function webpChunk(type, data) {
  const result = Buffer.alloc(8 + data.length + (data.length & 1));
  result.write(type, 0, 4, 'ascii'); result.writeUInt32LE(data.length, 4); data.copy(result, 8); return result;
}
export function referenceWithMetadata(ext) {
  if (ext === 'png') return Buffer.concat([referencePng.subarray(0, 33),
    pngChunk('tEXt', Buffer.from('Comment\0private GPS and camera')),
    pngChunk('eXIf', Buffer.from('private EXIF GPS')), referencePng.subarray(33)]);
  if (ext === 'jpg') return Buffer.concat([referenceJpeg.subarray(0, 2), jpegSegment(0xe1, 'Exif\0\0private GPS and camera'),
    jpegSegment(0xed, 'Photoshop private'), jpegSegment(0xfe, 'private comment'), referenceJpeg.subarray(2)]);
  const extended = Buffer.alloc(10); extended[0] = 0x2c; extended.writeUIntLE(2, 4, 3); extended.writeUIntLE(1, 7, 3);
  const body = Buffer.concat([webpChunk('VP8X', extended), webpChunk('ICCP', Buffer.from('private profile')),
    referenceWebp.subarray(12), webpChunk('EXIF', Buffer.from('private GPS and camera')), webpChunk('XMP ', Buffer.from('private XMP'))]);
  const header = Buffer.from(referenceWebp.subarray(0, 12)); header.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([header, body]);
}
