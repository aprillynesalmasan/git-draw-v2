const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const mkCode = () => Array.from({ length: 6 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join("");
const clip = (s) => String(s || "").trim().slice(0, 600);
const KEY = "gift:data";
const REV = (c) => "gift:rev:" + c;
const PROF = (id) => "gift:prof:" + id;
const PF = ["wishlist", "shirt", "shoe", "color", "notes"];
const getProf = async (id) => (id && (await redis.get(PROF(id)))) || {};

function isAdmin(pw) {
  const a = Buffer.from(String(pw || ""));
  const b = Buffer.from(process.env.ADMIN_PASSWORD || "");
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// people[] holds only {id,name,code}. Details live in separate keys so
// participants saving at the same time never overwrite each other.
async function load() {
  const d = (await redis.get(KEY)) || { people: [], assign: {} };
  let changed = false;
  const used = new Set(d.people.map((p) => p.code).filter(Boolean));
  for (const p of d.people) {
    if (!p.code) { // migrate older data
      let c = Object.keys(d.assign).find((k) => d.assign[k].giver === p.id);
      if (!c) { do { c = mkCode(); } while (used.has(c) || d.assign[c]); }
      p.code = c; used.add(c); changed = true;
    }
    if (PF.some((k) => p[k])) {
      const pr = {}; PF.forEach((k) => { pr[k] = p[k] || ""; delete p[k]; });
      await redis.set(PROF(p.id), pr); changed = true;
    }
  }
  if (changed) await redis.set(KEY, d);
  return d;
}

async function fullResult(d, a) {
  const giver = d.people.find((p) => p.id === a.giver);
  const r = d.people.find((p) => p.id === a.recipient) || {};
  const pr = await getProf(r.id);
  return {
    revealed: true, giver: giver ? giver.name : "", number: a.number, rName: r.name,
    wishlist: pr.wishlist || "", shirt: pr.shirt || "", shoe: pr.shoe || "",
    color: pr.color || "", notes: pr.notes || "",
  };
}

module.exports = async (req, res) => {
  const send = (o, c = 200) => res.status(c).json(o);
  if (req.method !== "POST") return send({ error: "POST only" }, 405);
  const b = req.body || {};
  try {
    const d = await load();
    const drawn = Object.keys(d.assign).length > 0;

    // ---------- Public: participants (need their own code) ----------
    if (["open", "save", "reveal"].includes(b.action)) {
      const code = String(b.code || "").trim().toUpperCase();
      const me = d.people.find((p) => p.code === code);
      if (!me) return send({ error: "Code not found. Check with the organizer." }, 404);
      const a = d.assign[code];

      if (b.action === "save") {
        const pr = {}; PF.forEach((k) => (pr[k] = clip(b[k])));
        await redis.set(PROF(me.id), pr);
        return send({ ok: true });
      }
      if (b.action === "reveal") {
        if (!a) return send({ error: "The draw hasn't started yet." }, 400);
        await redis.set(REV(code), Date.now(), { nx: true });
        return send(await fullResult(d, a));
      }
      const pr = await getProf(me.id);
      const base = {
        name: me.name, drawn: !!a,
        profile: { wishlist: pr.wishlist || "", shirt: pr.shirt || "", shoe: pr.shoe || "", color: pr.color || "", notes: pr.notes || "" },
      };
      if (a && (await redis.get(REV(code)))) return send({ ...base, revealed: true, result: await fullResult(d, a) });
      return send({ ...base, revealed: false });
    }

    // ---------- Admin ----------
    if (!isAdmin(b.pw)) return send({ error: "Wrong password" }, 401);

    if (b.action === "list") {
      const people = await Promise.all(
        d.people.map(async (p) => {
          const pr = await getProf(p.id);
          const filled = ["wishlist", "shirt", "shoe", "color"].filter((k) => pr[k]).length;
          const revealed = drawn ? !!(await redis.exists(REV(p.code))) : false;
          return { id: p.id, name: p.name, code: p.code, filled, revealed };
        })
      );
      return send({ people, drawn });
    }

    if (b.action === "add" || b.action === "remove") {
      if (drawn) return send({ error: "Draw already generated. Reset it first to change the list." }, 400);
      if (b.action === "add") {
        if (!clip(b.name)) return send({ error: "Name is required" }, 400);
        const used = new Set(d.people.map((p) => p.code));
        let c; do { c = mkCode(); } while (used.has(c));
        d.people.push({ id: crypto.randomUUID(), name: clip(b.name), code: c });
      } else {
        d.people = d.people.filter((p) => p.id !== b.id);
        await redis.del(PROF(b.id));
      }
      await redis.set(KEY, d);
      return send({ ok: true });
    }

    if (b.action === "generate") {
      const n = d.people.length;
      if (n < 3) return send({ error: "Add at least 3 people." }, 400);
      if (drawn) {
        const anyRevealed = (await Promise.all(d.people.map((p) => redis.exists(REV(p.code))))).some(Boolean);
        if (anyRevealed && b.confirm !== "RESET")
          return send({ error: "Some people already drew. Type RESET to wipe the results and redraw." }, 400);
        await Promise.all(d.people.map((p) => redis.del(REV(p.code))));
      }
      let idx;
      do {
        idx = d.people.map((_, i) => i);
        for (let i = n - 1; i > 0; i--) {
          const j = crypto.randomInt(i + 1);
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
      } while (!idx.every((v, i) => v !== i)); // nobody draws themselves
      const assign = {};
      d.people.forEach((p, i) => {
        assign[p.code] = { giver: p.id, recipient: d.people[idx[i]].id, number: idx[i] + 1 };
      });
      d.assign = assign;
      await redis.set(KEY, d);
      return send({ ok: true });
    }

    if (b.action === "reset") {
      if (b.confirm !== "RESET") return send({ error: "Type RESET to confirm." }, 400);
      await Promise.all(d.people.map((p) => redis.del(REV(p.code))));
      d.assign = {};
      await redis.set(KEY, d);
      return send({ ok: true });
    }

    return send({ error: "Unknown action" }, 400);
  } catch (e) {
    return send({ error: "Server error" }, 500);
  }
};
