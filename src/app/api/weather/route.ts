import { NextResponse } from "next/server";
import { chromium } from "playwright";

export const runtime = "nodejs";

function extractWindFromMetar(metar: string) {
  const m = metar.match(/\b(\d{3}|VRB)(\d{2,3})(G\d{2,3})?KT\b/);
  if (!m) {
    return { windDirection: null, windSpeedKt: null };
  }

  return {
    windDirection: m[1] === "VRB" ? null : Number(m[1]),
    windSpeedKt: Number(m[2]),
  };
}

function angleDiff(a: number, b: number) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function runwayResult(windDirection: number, windSpeedKt: number, runwayHeading: number) {
  const diff = angleDiff(windDirection, runwayHeading);
  const rad = (diff * Math.PI) / 180;

  const headwind = windSpeedKt * Math.cos(rad);
  const crosswind = Math.abs(windSpeedKt * Math.sin(rad));

  return {
    headwindKt: Math.round(headwind * 10) / 10,
    crosswindKt: Math.round(crosswind * 10) / 10,
  };
}

function chooseRunway(windDirection: number | null, windSpeedKt: number | null) {
  if (windDirection == null || windSpeedKt == null) {
    return { runway: "Unknown", heading: null, headwindKt: null, crosswindKt: null };
  }

  const r18 = runwayResult(windDirection, windSpeedKt, 181);
  const r36 = runwayResult(windDirection, windSpeedKt, 1);

  if (r18.headwindKt > r36.headwindKt) {
    return {
      runway: "18",
      heading: 181,
      headwindKt: r18.headwindKt,
      crosswindKt: r18.crosswindKt,
    };
  }

  return {
    runway: "36",
    heading: 1,
    headwindKt: r36.headwindKt,
    crosswindKt: r36.crosswindKt,
  };
}

function decodeMetar(metar: string) {
  if (!metar) return "No METAR found.";

  const lines: string[] = [];

  const issued = metar.match(/\b(\d{6})Z\b/);
  const wind = metar.match(/\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/);
  const variableWind = metar.match(/\b(\d{3})V(\d{3})\b/);
  const visibility = metar.match(/\b(9999|\d{4})\b/);
  const temp = metar.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  const qnh = metar.match(/\bQ(\d{4})\b/);

  if (issued) {
    const s = issued[1];
    lines.push(`Issued on the ${s.slice(0, 2)}th at ${s.slice(2, 4)}:${s.slice(4, 6)} UTC.`);
  }

  if (wind) {
    const dir = wind[1] === "VRB" ? "variable direction" : `${wind[1]}°`;
    const gust = wind[4] ? `, gusting ${wind[4]} kt` : "";
    lines.push(`Wind ${dir} at ${wind[2]} kt${gust}.`);
  }

  if (variableWind) {
    lines.push(`Variable wind direction between ${variableWind[1]}° and ${variableWind[2]}°.`);
  }

  if (metar.includes("CAVOK")) {
    lines.push("CAVOK: visibility 10 km or more, no significant cloud, no significant weather.");
  } else if (visibility) {
    if (visibility[1] === "9999") {
      lines.push("Visibility 10 km or more.");
    } else {
      lines.push(`Visibility ${visibility[1]} metres.`);
    }
  }

  if (temp) {
    const t = temp[1].startsWith("M") ? `-${temp[1].slice(1)}` : temp[1];
    const d = temp[2].startsWith("M") ? `-${temp[2].slice(1)}` : temp[2];
    lines.push(`Temperature ${t}°C, dew point ${d}°C.`);
  }

  if (qnh) {
    lines.push(`QNH ${qnh[1]} hPa.`);
  }

  return lines.join("\n");
}

function decodeTaf(taf: string) {
  if (!taf) return "No TAF found.";

  const parts: string[] = [];
  const tokens = taf.split(/\s+/).map((t) => t.replace(/=$/, ""));

  const issued = taf.match(/\b(\d{6})Z\b/);
  const validity = taf.match(/\b(\d{4})\/(\d{4})\b/);
  const wind = taf.match(/\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/);
  const variableWind = taf.match(/\b(\d{3})V(\d{3})\b/);
  const visibility = taf.match(/\b(9999|\d{4})\b/);
  const clouds = taf.match(/\b(FEW|SCT|BKN|OVC)(\d{3})\b/);

  function decodeWindToken(token: string) {
    const m = token.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT$/);
    if (!m) return null;

    const dir = m[1] === "VRB" ? "variable direction" : `${m[1]}°`;
    const gust = m[4] ? `, gusting ${m[4]} kt` : "";
    return `wind ${dir} at ${m[2]} kt${gust}`;
  }

  function decodeVisibilityToken(token: string) {
    if (token === "9999") return "visibility 10 km or more";
    if (/^\d{4}$/.test(token)) return `visibility ${token} metres`;
    return null;
  }

  function decodeCloudToken(token: string) {
    const m = token.match(/^(FEW|SCT|BKN|OVC)(\d{3})$/);
    if (!m) return null;

    const cloudMap: Record<string, string> = {
      FEW: "few clouds",
      SCT: "scattered clouds",
      BKN: "broken clouds",
      OVC: "overcast",
    };

    return `${cloudMap[m[1]]} at ${Number(m[2]) * 100} ft`;
  }

  function decodeConditionTokens(groupTokens: string[]) {
    const conditions: string[] = [];

    for (const rawToken of groupTokens) {
      const token = rawToken.replace(/=$/, "");

      const windText = decodeWindToken(token);
      if (windText) {
        conditions.push(windText);
        continue;
      }

      const visText = decodeVisibilityToken(token);
      if (visText) {
        conditions.push(visText);
        continue;
      }

      const cloudText = decodeCloudToken(token);
      if (cloudText) {
        conditions.push(cloudText);
        continue;
      }

      if (token === "CAVOK") {
        conditions.push("CAVOK, visibility 10 km or more, no significant cloud, no significant weather");
        continue;
      }

      if (token === "NSW") {
        conditions.push("no significant weather");
        continue;
      }
    }

    return conditions;
  }

  if (issued) {
    const s = issued[1];
    parts.push(`Issued on the ${s.slice(0, 2)}th at ${s.slice(2, 4)}:${s.slice(4, 6)} UTC.`);
  }

  if (validity) {
    const from = validity[1];
    const to = validity[2];
    parts.push(
      `Valid from the ${from.slice(0, 2)}th at ${from.slice(2, 4)}:00 UTC until the ${to.slice(0, 2)}th at ${to.slice(2, 4)}:00 UTC.`
    );
  }

  if (wind) {
    const dir = wind[1] === "VRB" ? "variable direction" : `${wind[1]}°`;
    const gust = wind[4] ? `, gusting ${wind[4]} kt` : "";
    parts.push(`Forecast wind ${dir} at ${wind[2]} kt${gust}.`);
  }

  if (variableWind) {
    parts.push(`Variable wind direction between ${variableWind[1]}° and ${variableWind[2]}°.`);
  }

  if (taf.includes("CAVOK")) {
    parts.push("CAVOK: visibility 10 km or more, no significant cloud, no significant weather.");
  } else if (visibility) {
    if (visibility[1] === "9999") {
      parts.push("Forecast visibility 10 km or more.");
    } else {
      parts.push(`Forecast visibility ${visibility[1]} metres.`);
    }
  }

  if (clouds) {
    const cloudMap: Record<string, string> = {
      FEW: "few clouds",
      SCT: "scattered clouds",
      BKN: "broken clouds",
      OVC: "overcast",
    };

    parts.push(`${cloudMap[clouds[1]]} at ${Number(clouds[2]) * 100} ft.`);
  }

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "BECMG" && i + 1 < tokens.length && /^\d{4}\/\d{4}$/.test(tokens[i + 1])) {
      const period = tokens[i + 1];
      const groupTokens: string[] = [];

      for (let j = i + 2; j < tokens.length; j++) {
        const checkToken = tokens[j].replace(/=$/, "");

        if (
          checkToken === "BECMG" ||
          checkToken === "TEMPO" ||
          checkToken.startsWith("FM") ||
          checkToken === "PROB30" ||
          checkToken === "PROB40"
        ) {
          break;
        }

        groupTokens.push(checkToken);
      }

      const decodedConditions = decodeConditionTokens(groupTokens);
      const conditionText =
        decodedConditions.length > 0
          ? ` Conditions becoming: ${decodedConditions.join(", ")}.`
          : "";

      parts.push(
        `BECMG: becoming between the ${period.slice(0, 2)}th ${period.slice(2, 4)}:00 UTC and the ${period.slice(5, 7)}th ${period.slice(7, 9)}:00 UTC.${conditionText}`
      );
    }

    if (tokens[i] === "TEMPO" && i + 1 < tokens.length && /^\d{4}\/\d{4}$/.test(tokens[i + 1])) {
      const period = tokens[i + 1];
      const groupTokens: string[] = [];

      for (let j = i + 2; j < tokens.length; j++) {
        const checkToken = tokens[j].replace(/=$/, "");

        if (
          checkToken === "BECMG" ||
          checkToken === "TEMPO" ||
          checkToken.startsWith("FM") ||
          checkToken === "PROB30" ||
          checkToken === "PROB40"
        ) {
          break;
        }

        groupTokens.push(checkToken);
      }

      const decodedConditions = decodeConditionTokens(groupTokens);
      const conditionText =
        decodedConditions.length > 0
          ? ` Temporary conditions: ${decodedConditions.join(", ")}.`
          : "";

      parts.push(
        `TEMPO: temporary conditions between the ${period.slice(0, 2)}th ${period.slice(2, 4)}:00 UTC and the ${period.slice(5, 7)}th ${period.slice(7, 9)}:00 UTC.${conditionText}`
      );
    }

    if (tokens[i].startsWith("FM") && /^FM\d{6}$/.test(tokens[i])) {
      const fm = tokens[i];
      const groupTokens: string[] = [];

      for (let j = i + 1; j < tokens.length; j++) {
        const checkToken = tokens[j].replace(/=$/, "");

        if (
          checkToken === "BECMG" ||
          checkToken === "TEMPO" ||
          checkToken.startsWith("FM") ||
          checkToken === "PROB30" ||
          checkToken === "PROB40"
        ) {
          break;
        }

        groupTokens.push(checkToken);
      }

      const decodedConditions = decodeConditionTokens(groupTokens);
      const conditionText =
        decodedConditions.length > 0
          ? ` New conditions from then: ${decodedConditions.join(", ")}.`
          : "";

      parts.push(
        `FM: from the ${fm.slice(2, 4)}th at ${fm.slice(4, 6)}:${fm.slice(6, 8)} UTC.${conditionText}`
      );
    }
  }

  if (taf.includes("PROB30")) {
    parts.push("PROB30: 30% probability of the specified conditions.");
  }

  if (taf.includes("PROB40")) {
    parts.push("PROB40: 40% probability of the specified conditions.");
  }

  return parts.join("\n");
}

function extractMetarAndTaf(text: string) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let metar = "";
  let taf = "";
  let collectingTaf = false;

  const tafLines: string[] = [];

  for (const line of lines) {
    if (!metar && line.startsWith("METAR LHNY")) {
      metar = line;
    }

    if (line.startsWith("TAF LHNY")) {
      collectingTaf = true;
      tafLines.push(line);
      continue;
    }

    if (collectingTaf) {
      if (
        line.startsWith("GAMET") ||
        line.startsWith("SIGMET") ||
        line.startsWith("AIRMET") ||
        line.startsWith("METAR") ||
        line.startsWith("SPECI")
      ) {
        break;
      }

      tafLines.push(line);
    }
  }

  taf = tafLines.join(" ").trim();

  return { metar, taf };
}

function extractWindFromToken(token: string) {
  const cleanToken = token.replace(/=$/, "");
  const m = cleanToken.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT$/);
  if (!m) return null;

  return {
    windDirection: m[1] === "VRB" ? null : Number(m[1]),
    windSpeedKt: Number(m[2]),
  };
}

function findProbableRunwayChange(rawTaf: string, currentRunway: string) {
  if (!rawTaf || currentRunway === "Unknown") return null;

  const tokens = rawTaf.split(/\s+/).map((t) => t.replace(/=$/, ""));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    let text: string | null = null;
    let windToken: string | null = null;

    if (token === "BECMG" && i + 2 < tokens.length) {
      const period = tokens[i + 1];
      if (/^\d{4}\/\d{4}$/.test(period)) {
        text = `Probable runway change at ${period.slice(2, 4)}:00`;

        for (let j = i + 2; j < Math.min(i + 8, tokens.length); j++) {
          const checkToken = tokens[j].replace(/=$/, "");
          if (/^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/.test(checkToken)) {
            windToken = checkToken;
            break;
          }
        }
      }
    }

    if (token === "TEMPO" && i + 2 < tokens.length) {
      const period = tokens[i + 1];
      if (/^\d{4}\/\d{4}$/.test(period)) {
        text = `Possible temporary runway change at ${period.slice(2, 4)}:00`;

        for (let j = i + 2; j < Math.min(i + 8, tokens.length); j++) {
          const checkToken = tokens[j].replace(/=$/, "");
          if (/^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/.test(checkToken)) {
            windToken = checkToken;
            break;
          }
        }
      }
    }

    if (token.startsWith("FM") && /^FM\d{6}$/.test(token)) {
      text = `Runway change expected from ${token.slice(4, 6)}:${token.slice(6, 8)}`;

      for (let j = i + 1; j < Math.min(i + 6, tokens.length); j++) {
        const checkToken = tokens[j].replace(/=$/, "");
        if (/^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/.test(checkToken)) {
          windToken = checkToken;
          break;
        }
      }
    }

    if (text && windToken) {
      const wind = extractWindFromToken(windToken);
      if (!wind) continue;

      const predicted = chooseRunway(wind.windDirection, wind.windSpeedKt);

      if (predicted.runway !== "Unknown" && predicted.runway !== currentRunway) {
        return text;
      }
    }
  }

  return null;
}

export async function GET() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  try {
    await page.goto(process.env.LHNY_URL!, { waitUntil: "domcontentloaded" });

    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[name="user"], input[name="username"]')
      .first();
    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();

    await emailInput.fill(process.env.AVIATION_MET_USER || "");
    await passwordInput.fill(process.env.AVIATION_MET_PASSWORD || "");

    const loginButton = page
      .locator('button[type="submit"], input[type="submit"], button, input[type="button"]')
      .first();
    await loginButton.click();

    await page.waitForLoadState("domcontentloaded");
    await page.goto(process.env.LHNY_URL!, { waitUntil: "domcontentloaded" });

    const bodyText = await page.locator("body").innerText();
    const { metar, taf } = extractMetarAndTaf(bodyText);

    const wind = extractWindFromMetar(metar);
    const runway = chooseRunway(wind.windDirection, wind.windSpeedKt);
    const probableRunwayChangeAt = findProbableRunwayChange(taf, runway.runway);

    return NextResponse.json({
      station: "LHNY",
      rawMetar: metar,
      rawTaf: taf,
      decodedMetar: decodeMetar(metar),
      decodedTaf: decodeTaf(taf),
      runwayInUse: runway.runway,
      probableRunwayChangeAt,
      headwindKt: runway.headwindKt,
      crosswindKt: runway.crosswindKt,
      windDirection: wind.windDirection,
      windSpeedKt: wind.windSpeedKt,
      sourceUrl: process.env.LHNY_URL,
      fetchedAt: new Date().toISOString(),
      note: "Runway is a wind-based recommendation, not an official assigned runway.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 }
    );
  } finally {
    await browser.close();
  }
}