const WP_POST_URL = "https://lahiradio.fi/wp-json/wp/v2/posts/6444";

// Finnish day names in order Sun=0, Mon=1, ... Sat=6
const FI_DAYS = [
  "Sunnuntai",   // 0 Sunday
  "Maanantai",   // 1 Monday
  "Tiistai",     // 2 Tuesday
  "Keskiviikko", // 3 Wednesday
  "Torstai",     // 4 Thursday
  "Perjantai",   // 5 Friday
  "Lauantai",    // 6 Saturday
];

/**
 * Parse the HTML schedule from the WP post content.
 * Returns a map: { "Maanantai": [{time, title, url, desc}, ...], ... }
 */
function parseSchedule(html) {
  const schedule = {};
  let currentDay = null;

  // Split on table rows to process line by line
  // Strategy: find day headings then collect table rows until next heading
  // The HTML uses <strong>DayName</strong> as headings between <table> blocks

  // Extract all day sections by splitting on the day name pattern
  // Day headings look like: <strong>Maanantai</strong> or variations
  const dayPattern = new RegExp(
    `<strong>(${FI_DAYS.join("|")})<\\/strong>`,
    "gi"
  );

  let lastIndex = 0;
  let match;
  const sections = []; // [{day, startIndex}]

  while ((match = dayPattern.exec(html)) !== null) {
    sections.push({ day: match[1], index: match.index });
  }

  for (let i = 0; i < sections.length; i++) {
    const { day, index } = sections[i];
    const end = i + 1 < sections.length ? sections[i + 1].index : html.length;
    const chunk = html.slice(index, end);

    const programs = [];

    // Extract table rows: each <tr> has two <td>s: time and program
    const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(chunk)) !== null) {
      const row = rowMatch[0];

      // Extract time from first td (6% width)
      const timeMatch = row.match(/(\d{2}:\d{2})/);
      if (!timeMatch) continue;
      const time = timeMatch[1];

      // Extract program title and URL from <a> tag
      const linkMatch = row.match(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
      const title = linkMatch ? linkMatch[2].trim() : null;
      const url = linkMatch ? linkMatch[1].trim() : null;

      if (!title) continue;

      // Extract description: text in the 2nd td after the </a> tag
      // Get the second <td> content
      const tds = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
      let desc = "";
      if (tds && tds.length >= 2) {
        const secondTd = tds[1];
        // Strip all tags, trim
        desc = secondTd
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        // Remove the title from the description
        desc = desc.replace(title + ".", "").replace(title, "").trim();
        // Clean up leading punctuation
        desc = desc.replace(/^[\s.,]+/, "").trim();
      }

      programs.push({ time, title, url, desc });
    }

    // Normalize day name capitalisation for lookup
    const dayKey = day.charAt(0).toUpperCase() + day.slice(1).toLowerCase();
    schedule[dayKey] = programs;
  }

  return schedule;
}

/**
 * Given the full week schedule, return programs in the next `hours` hours
 * from `now` (a Date object in Helsinki time).
 */
function getNext24h(schedule, now, hours = 24) {
  const results = [];

  // Helsinki is UTC+2 (EET) or UTC+3 (EEST, summer). Use Intl to get local values.
  const helsinkiFormatter = new Intl.DateTimeFormat("fi-FI", {
    timeZone: "Europe/Helsinki",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  });

  const parts = helsinkiFormatter.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const currentHour = parseInt(get("hour"), 10);
  const currentMin = parseInt(get("minute"), 10);
  const currentMinutes = currentHour * 60 + currentMin;
  const cutoffMinutes = currentMinutes + hours * 60; // may exceed 1440 (next day)

  // Day index in Helsinki: 0=Sun ... 6=Sat
  const helsinkiDayIndex = ["su", "ma", "ti", "ke", "to", "pe", "la"].indexOf(
    get("weekday")
  );

  // Map Finnish short → index
  const fiShortToIdx = { su: 0, ma: 1, ti: 2, ke: 3, to: 4, pe: 5, la: 6 };
  const dayIdx =
    helsinkiDayIndex >= 0
      ? helsinkiDayIndex
      : (() => {
          // Fallback: use JS getDay mapped through Helsinki offset
          const helsinkiDate = new Date(
            now.toLocaleString("en-US", { timeZone: "Europe/Helsinki" })
          );
          return helsinkiDate.getDay(); // 0=Sun
        })();

  // We'll look at today and tomorrow (covers rolling 24h crossing midnight)
  for (let offset = 0; offset <= 1; offset++) {
    const checkDayIdx = (dayIdx + offset) % 7;
    const dayName = FI_DAYS[checkDayIdx];
    const programs = schedule[dayName] || [];

    for (const prog of programs) {
      const [h, m] = prog.time.split(":").map(Number);
      const progMinutes = offset * 1440 + h * 60 + m;

      if (progMinutes >= currentMinutes && progMinutes < cutoffMinutes) {
        results.push({
          day: dayName,
          time: prog.time,
          title: prog.title,
          url: prog.url,
          desc: prog.desc,
        });
      }
    }
  }

  return results;
}

export default {
  async fetch(request, env) {
    // Optional bearer token check
    if (env.TRMNL_TOKEN) {
      const auth = request.headers.get("Authorization") || "";
      const token = new URL(request.url).searchParams.get("token") || "";
      if (!auth.includes(env.TRMNL_TOKEN) && token !== env.TRMNL_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      const wpRes = await fetch(WP_POST_URL, {
        headers: { Accept: "application/json" },
        cf: { cacheTtl: 3600, cacheEverything: true }, // cache at CF edge for 1h
      });

      if (!wpRes.ok) {
        return Response.json(
          { error: `WP API error: ${wpRes.status}` },
          { status: 502 }
        );
      }

      const wpData = await wpRes.json();
      const html = wpData.content?.rendered || "";

      const schedule = parseSchedule(html);
      const now = new Date();
      const upcoming = getNext24h(schedule, now, 24);

      const helsinkiNow = new Date(
        now.toLocaleString("en-US", { timeZone: "Europe/Helsinki" })
      );

      return Response.json(
        {
          updated_at: now.toISOString(),
          current_time: helsinkiNow.toLocaleTimeString("fi-FI", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          programs: upcoming,
          total: upcoming.length,
        },
        {
          headers: {
            "Cache-Control": "public, max-age=900", // 15min browser cache
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  },
};
