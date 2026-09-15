(function (app) {
  "use strict";

  function utf8(value) { return new TextEncoder().encode(String(value)); }
  function rotr(value, bits) { return value >>> bits | value << 32 - bits; }
  function sha256(input) {
    var bytes = input instanceof Uint8Array ? input : utf8(input), length = bytes.length, bitLength = length * 8;
    var padded = new Uint8Array(((length + 9 + 63) >> 6) << 6); padded.set(bytes); padded[length] = 128;
    var view = new DataView(padded.buffer); view.setUint32(padded.length - 4, bitLength >>> 0); view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
    var h = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
    var k = [1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298];
    for (var offset = 0; offset < padded.length; offset += 64) {
      var w = new Uint32Array(64), i;
      for (i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
      for (i = 16; i < 64; i += 1) { var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3; var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10; w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0; }
      var a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
      for (i = 0; i < 64; i += 1) { var S1=rotr(e,6)^rotr(e,11)^rotr(e,25), ch=e&f^~e&g, t1=(hh+S1+ch+k[i]+w[i])>>>0, S0=rotr(a,2)^rotr(a,13)^rotr(a,22), maj=a&b^a&c^b&c, t2=(S0+maj)>>>0; hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
      h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
    }
    var output = new Uint8Array(32), out = new DataView(output.buffer); h.forEach(function (value, index) { out.setUint32(index * 4, value); }); return output;
  }
  function hmac(key, message) {
    var input = key instanceof Uint8Array ? key : utf8(key); if (input.length > 64) input = sha256(input);
    var inner = new Uint8Array(64), outer = new Uint8Array(64); inner.fill(54); outer.fill(92);
    for (var i = 0; i < input.length; i += 1) { inner[i] ^= input[i]; outer[i] ^= input[i]; }
    var messageBytes = message instanceof Uint8Array ? message : utf8(message), first = new Uint8Array(inner.length + messageBytes.length); first.set(inner); first.set(messageBytes, inner.length);
    var digest = sha256(first), second = new Uint8Array(outer.length + digest.length); second.set(outer); second.set(digest, outer.length); return sha256(second);
  }
  function hex(bytes) { return Array.prototype.map.call(bytes, function (value) { return value.toString(16).padStart(2, "0"); }).join(""); }
  function encode(value) { return encodeURIComponent(value).replace(/[!'()*]/g, function (char) { return "%" + char.charCodeAt(0).toString(16).toUpperCase(); }); }
  function canonicalQuery(url) { var items = []; url.searchParams.forEach(function (value, key) { items.push([encode(key), encode(value)]); }); items.sort(function (left, right) { return left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0]); }); return items.map(function (item) { return item[0] + "=" + item[1]; }).join("&"); }
  function canonicalPath(path) { return String(path || "/").split("/").map(encode).join("/") || "/"; }
  function amzDate(date) { return date.toISOString().replace(/[:-]|\.\d{3}/g, ""); }

  function sign(options) {
    var url = new URL(options.url), now = options.date || new Date(), timestamp = amzDate(now), day = timestamp.slice(0, 8);
    var body = options.body == null ? "" : String(options.body), payloadHash = hex(sha256(body));
    var headers = {}, source = Object.assign({}, options.headers || {}, { "content-type": options.contentType || "application/json", "x-amz-date": timestamp, "x-amz-content-sha256": payloadHash });
    if (options.sessionToken) source["x-amz-security-token"] = options.sessionToken;
    Object.keys(source).forEach(function (name) { headers[name.toLowerCase()] = String(source[name]).trim().replace(/\s+/g, " "); });
    var canonicalHeaders = Object.keys(headers).concat(["host"]).sort(), signedHeaders = canonicalHeaders.join(";");
    var headerText = canonicalHeaders.map(function (name) { return name + ":" + (name === "host" ? url.host : headers[name]) + "\n"; }).join("");
    var canonical = String(options.method || "GET").toUpperCase() + "\n" + canonicalPath(url.pathname) + "\n" + canonicalQuery(url) + "\n" + headerText + "\n" + signedHeaders + "\n" + payloadHash;
    var scope = day + "/" + options.region + "/" + (options.service || "polly") + "/aws4_request";
    var stringToSign = "AWS4-HMAC-SHA256\n" + timestamp + "\n" + scope + "\n" + hex(sha256(canonical));
    var dateKey = hmac("AWS4" + options.secretAccessKey, day), regionKey = hmac(dateKey, options.region), serviceKey = hmac(regionKey, options.service || "polly"), signingKey = hmac(serviceKey, "aws4_request");
    headers.Authorization = "AWS4-HMAC-SHA256 Credential=" + options.accessKeyId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + hex(hmac(signingKey, stringToSign));
    delete headers.host;
    return headers;
  }

  app.services = app.services || {};
  app.services.awsSigV4 = { sign: sign, sha256Hex: function (value) { return hex(sha256(value)); } };
})(window.chataxi);
