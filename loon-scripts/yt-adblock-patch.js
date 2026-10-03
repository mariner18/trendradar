// Loon http-response 补丁：清理 YouTube 新版式 InnerTube 响应里的广告
//
// 背景：Maasea 的 youtube.response.js 用 2026-07 编译的 protobuf schema 解析响应，
// YouTube 灰度推送的新版式把内容搬进了 schema 不认识的扩展字段（browse 的 field 10、
// next 的 field 15/42），原脚本的遍历器看不到，直接放行，导致"时灵时不灵"。
//
// 本补丁不依赖 schema，直接在字节层面做通用 protobuf 解析，自底向上删掉所有
// 子树含有 "pagead" 的 length-delimited 字段（和原脚本同款广告信号）。
// 纯删除字段，不改其他字节，输出仍是合法 protobuf；解析失败/无广告时原样放行。
//
// Loon 配置（放在 Maasea 脚本之前或之后均可，建议之前）：
//   http-response ^https://youtubei\.googleapis\.com/youtubei/v1/(browse|next|search) \
//     script-path=https://你的地址/yt-adblock-patch.js, requires-body=true, timeout=30

(function () {
  'use strict';

  // ---------- 输入/输出 ----------
  function getBodyBytes() {
    var b = $response.body;
    if (b instanceof Uint8Array) return b;
    if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return new Uint8Array(b);
    if (typeof b === 'string') {
      var u8 = new Uint8Array(b.length);
      for (var i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i) & 0xff;
      return u8;
    }
    return null;
  }

  // ---------- 通用 protobuf 解析（无 schema） ----------
  // field: { no, wt, vStart, vEnd, tagStart, tagEnd, fEnd }，wt==2 时 [vStart,vEnd) 为值区间
  // 返回 { fields, ok }：ok 表示 [s,e) 被完整合法地解析；遇到非法/截断时 ok=false
  function parseFields(buf, s, e) {
    var fields = [];
    var pos = s;
    var ok = true;
    while (pos < e) {
      var tagStart = pos;
      var tag = 0, shift = 0, b;
      do {
        if (pos >= e) { ok = false; break; }
        b = buf[pos++];
        tag += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if (shift > 70) { ok = false; break; }
      } while (b & 0x80);
      if (!ok) break;
      var tagEnd = pos;
      var wt = tag % 8;
      var no = Math.floor(tag / 8);
      if (no <= 0 || no >= 536870912) { ok = false; break; }
      var vStart = pos, vEnd = pos;
      if (wt === 0) {
        var v = 0; shift = 0;
        do {
          if (pos >= e) { ok = false; break; }
          b = buf[pos++];
          v += (b & 0x7f) * Math.pow(2, shift);
          shift += 7;
          if (shift > 70) { ok = false; break; }
        } while (b & 0x80);
        if (!ok) break;
        vEnd = pos;
      } else if (wt === 1) {
        vEnd = pos + 8;
      } else if (wt === 5) {
        vEnd = pos + 4;
      } else if (wt === 2) {
        var len = 0; shift = 0;
        do {
          if (pos >= e) { ok = false; break; }
          b = buf[pos++];
          len += (b & 0x7f) * Math.pow(2, shift);
          shift += 7;
          if (shift > 70) { ok = false; break; }
        } while (b & 0x80);
        if (!ok) break;
        vStart = pos; vEnd = pos + len;
      } else { ok = false; break; } // group(3/4) 已废弃：视为不透明
      if (vEnd > e) { ok = false; break; }
      pos = vEnd;
      fields.push({ no: no, wt: wt, vStart: vStart, vEnd: vEnd,
                    tagStart: tagStart, tagEnd: tagEnd, fEnd: vEnd });
    }
    return { fields: fields, ok: ok && pos === e };
  }

  function encodeVarint(v) {
    var out = [];
    v = Math.floor(v);
    do {
      var bits = v % 128;
      v = Math.floor(v / 128);
      out.push(v > 0 ? bits | 0x80 : bits);
    } while (v > 0);
    return out;
  }

  // ---------- 广告信号：pagead（大小写不敏感） ----------
  var P_AGEAD = [112, 97, 103, 101, 97, 100]; // "pagead"
  function containsPagead(buf, s, e) {
    outer: for (var i = s; i + 6 <= e; i++) {
      for (var j = 0; j < 6; j++) {
        if (((buf[i + j] | 32)) !== P_AGEAD[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  // ---------- 自底向上清理 ----------
  // 返回 { bytes, dropped }：
  // - 子树无 pagead → 直接返回原切片（零拷贝）
  // - 子树不是合法 protobuf（纯字符串/二进制 blob）→ 原样保留，交由上层判断
  // - 合法 message → 递归清理后，删掉仍含 pagead 的 LD 字段（广告容器），
  //   以及被掏空的容器（避免留下客户端渲染不了的空壳 section）
  function cleanRange(buf, s, e) {
    if (!containsPagead(buf, s, e)) return { bytes: buf.subarray(s, e), dropped: 0 };
    var pr = parseFields(buf, s, e);
    if (!pr.ok) return { bytes: buf.subarray(s, e), dropped: 0 }; // 不透明字节：原样保留
    var fields = pr.fields;
    var chunks = [];
    var dropped = 0;
    for (var k = 0; k < fields.length; k++) {
      var f = fields[k];
      if (f.wt === 2) {
        var cleaned = cleanRange(buf, f.vStart, f.vEnd);
        dropped += cleaned.dropped;
        var cbytes = cleaned.bytes;
        if (cbytes.length === 0 && f.vEnd > f.vStart) {
          dropped++; // 广告容器被掏空：整个删掉，不留空壳
          continue;
        }
        if (containsPagead(cbytes, 0, cbytes.length)) {
          dropped++; // 子树仍含广告信号：整个字段是广告容器，删掉
          continue;
        }
        chunks.push(buf.subarray(f.tagStart, f.tagEnd)); // tag 原字节保留
        chunks.push(encodeVarint(cbytes.length));
        chunks.push(cbytes);
      } else {
        chunks.push(buf.subarray(f.tagStart, f.fEnd)); // 非 LD 字段原样保留
      }
    }
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var p = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].length; }
    return { bytes: out, dropped: dropped };
  }

  // ---------- 主流程（fail-open：异常一律原样放行） ----------
  try {
    var body = getBodyBytes();
    if (!body || body.length === 0) { $done({}); return; }
    var r = cleanRange(body, 0, body.length);
    if (r.dropped > 0) {
      if (r.bytes.length < body.length * 0.45) {
        // 熔断：删除量超过 55% 说明可能误删，直接放行保页面
        console.log('[yt-ad-patch] over-deletion guard (' + body.length +
          ' -> ' + r.bytes.length + '), passthrough');
        $done({});
        return;
      }
      console.log('[yt-ad-patch] dropped ' + r.dropped + ' ad field(s), ' +
        body.length + ' -> ' + r.bytes.length + ' bytes');
      $done({ body: r.bytes });
    } else {
      $done({});
    }
  } catch (err) {
    console.log('[yt-ad-patch] error: ' + err);
    $done({});
  }
})();
