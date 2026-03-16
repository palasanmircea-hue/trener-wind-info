import { NextResponse } from "next/server";
import { chromium } from "playwright";

export const runtime = "nodejs";

const MAGNETIC_VARIATION_EAST = 6.3;
const CLIMB_SPEED_KT = 75;
const DESCENT_SPEED_KT = 75;
const DOWNWIND_SPEED_KT = 95;

function normalize360(value: number) {
  let v = value % 360;
  if (v < 0) v += 360;
  return v;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function round0(value: number) {
  return Math.round(value);
}

function trueToMagnetic(trueDirection: number) {
  return round1(normalize360(trueDirection - MAGNETIC_VARIATION_EAST));
}

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
    headwindKt: round1(headwind),
    crosswindKt: round1(crosswind),
  };
}

function chooseRunway(windDirection: number | null, windSpeedKt: number | null) {
  if (windDirection == null || windSpeedKt == null) {
    return {
      runway: "Unknown",
      heading: null,
      headwindKt: null,
      crosswindKt: null,
    };
  }

  const r18 = runwayResult(windDirection, windSpeedKt, 175);
  const r36 = runwayResult(windDirection, windSpeedKt, 355);

  if (r18.headwindKt > r36.headwindKt) {
    return {
      runway: "18",
      heading: 175,
      headwindKt: r18.headwindKt,
      crosswindKt: r18.crosswindKt,
    };
  }

  return {
    runway: "36",
    heading: 355,
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

      if (decodedConditions.length > 0) {
        parts.push(
          `BECMG: conditions becoming ${decodedConditions.join(", ")} between the ${period.slice(0, 2)}th ${period.slice(2, 4)}:00 UTC and the ${period.slice(5, 7)}th ${period.slice(7, 9)}:00 UTC.`
        );
      } else {
        parts.push(
          `BECMG: conditions becoming between the ${period.slice(0, 2)}th ${period.slice(2, 4)}:00 UTC and the ${period.slice(5, 7)}th ${period.slice(7, 9)}:00 UTC.`
        );
      }
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

      if (decodedConditions.length > 0) {
        parts.push(
          `TEMPO: temporary conditions of ${decodedConditions.join(", ")} between the ${period.slice(0, 2)}th ${period.slice(2, 4)}:00 UTC and the ${period.slice(5, 7)}th ${period.slice(7, 9)}:00 UTC.`
        );
      } else {
        parts.push(
          `TEMPO: temporary conditions between the ${period.slice(0, 2)}th ${period.slice(2, 4)}:00 UTC and the ${period.slice(5, 7)}th ${period.slice(7, 9)}:00 UTC.`
        );
      }
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

      if (decodedConditions.length > 0) {
        parts.push(
          `FM: from the ${fm.slice(2, 4)}th at ${fm.slice(4, 6)}:${fm.slice(6, 8)} UTC, conditions becoming ${decodedConditions.join(", ")}.`
        );
      } else {
        parts.push(`FM: from the ${fm.slice(2, 4)}th at ${fm.slice(4, 6)}:${fm.slice(6, 8)} UTC.`);
      }
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

      const magneticWindDirection =
        wind.windDirection == null ? null : trueToMagnetic(wind.windDirection);

      const predicted = chooseRunway(magneticWindDirection, wind.windSpeedKt);

      if (predicted.runway !== "Unknown" && predicted.runway !== currentRunway) {
        return text;
      }
    }
  }

  return null;
}

function directedTurnDelta(fromHeading: number, toHeading: number, direction: "left" | "right") {
  if (direction === "left") {
    return normalize360(fromHeading - toHeading);
  }
  return normalize360(toHeading - fromHeading);
}

function windRelativeToTrack(windFromDeg: number, trackDeg: number) {
  const relative = normalize360(windFromDeg - trackDeg);
  return relative > 180 ? relative - 360 : relative;
}

function windCorrectionAngle(
  trueAirspeed: number,
  windSpeed: number,
  windFromDeg: number,
  desiredTrackDeg: number
) {
  const relative = windRelativeToTrack(windFromDeg, desiredTrackDeg);
  const crosswind = windSpeed * Math.sin((relative * Math.PI) / 180);
  const ratio = Math.max(-1, Math.min(1, crosswind / trueAirspeed));
  return (Math.asin(ratio) * 180) / Math.PI;
}

function groundSpeedOnTrack(
  trueAirspeed: number,
  windSpeed: number,
  windFromDeg: number,
  desiredTrackDeg: number
) {
  const wca = windCorrectionAngle(trueAirspeed, windSpeed, windFromDeg, desiredTrackDeg);
  const relative = windRelativeToTrack(windFromDeg, desiredTrackDeg);
  const headwind = windSpeed * Math.cos((relative * Math.PI) / 180);
  return round1(trueAirspeed * Math.cos((wca * Math.PI) / 180) - headwind);
}

function crosswindSideText(windFromDeg: number, runwayHeading: number) {
  const relative = windRelativeToTrack(windFromDeg, runwayHeading);
  const crosswind = Math.sin((relative * Math.PI) / 180);

  if (Math.abs(crosswind) < 0.12) return "almost no crosswind";
  return crosswind > 0 ? "crosswind from the right" : "crosswind from the left";
}

function aileronIntoWindText(windFromDeg: number, runwayHeading: number) {
  const relative = windRelativeToTrack(windFromDeg, runwayHeading);
  const crosswind = Math.sin((relative * Math.PI) / 180);

  if (Math.abs(crosswind) < 0.12) return "little or no aileron correction needed";
  return crosswind > 0 ? "aileron into wind from the right" : "aileron into wind from the left";
}

function turnDescription(delta: number) {
  if (delta > 93) return `more than 90° (about ${round0(delta)}°)`;
  if (delta < 87) return `less than 90° (about ${round0(delta)}°)`;
  return `about 90°`;
}

function eastWestPushText(windFromDeg: number, windSpeedKt: number) {
  const toDir = normalize360(windFromDeg + 180);
  const eastPush = windSpeedKt * Math.sin((toDir * Math.PI) / 180);

  if (eastPush < -1.5) return "away from the runway";
  if (eastPush > 1.5) return "toward the runway";
  return "with little sideways drift relative to the runway";
}

function descentPlanningText(downwindGs: number) {
  if (downwindGs > DOWNWIND_SPEED_KT + 3) {
    return "Descent should be started earlier or with lower power because groundspeed on downwind is higher.";
  }
  if (downwindGs < DOWNWIND_SPEED_KT - 3) {
    return "Descent can be started a little later or with slightly higher power because groundspeed on downwind is lower.";
  }
  return "Use normal descent timing and power, with small corrections as needed.";
}

function finalTurnAltitudeText(windSpeedKt: number, finalCrosswindKt: number) {
  if (windSpeedKt >= 12 || finalCrosswindKt >= 7) {
    return "Final turn nominal altitude is 800 ft, but 850 to 900 ft may give a more stable rollout and allow a steeper, controlled descent.";
  }
  return "Final turn nominal altitude of 800 ft is normally appropriate.";
}

function flapText(finalCrosswindKt: number) {
  if (finalCrosswindKt >= 8) {
    return "Flap 3 is normal, but reduced flap may improve control and crosswind handling if conditions require it.";
  }
  return "Flap 3 is normally appropriate.";
}

function generateVisualCircuitRecommendations(
  runway: string,
  runwayHeading: number | null,
  windDirection: number | null,
  windSpeedKt: number | null
) {
  if (!runwayHeading || windDirection == null || windSpeedKt == null) {
    return "No visual circuit recommendations available.";
  }

  const circuit = runway === "36"
    ? {
        upwindTrack: 355,
        crosswindTrack: 265,
        downwindTrack: 175,
        baseTrack: 85,
        finalTrack: 355,
        turnDir: "left" as const,
      }
    : {
        upwindTrack: 175,
        crosswindTrack: 265,
        downwindTrack: 355,
        baseTrack: 85,
        finalTrack: 175,
        turnDir: "right" as const,
      };

  const upwindHeading =
    circuit.upwindTrack +
    windCorrectionAngle(CLIMB_SPEED_KT, windSpeedKt, windDirection, circuit.upwindTrack);

  const crosswindHeading =
    circuit.crosswindTrack +
    windCorrectionAngle(CLIMB_SPEED_KT, windSpeedKt, windDirection, circuit.crosswindTrack);

  const downwindHeading =
    circuit.downwindTrack +
    windCorrectionAngle(DOWNWIND_SPEED_KT, windSpeedKt, windDirection, circuit.downwindTrack);

  const baseHeading =
    circuit.baseTrack +
    windCorrectionAngle(DESCENT_SPEED_KT, windSpeedKt, windDirection, circuit.baseTrack);

const upwindGs = groundSpeedOnTrack(
  CLIMB_SPEED_KT,
  windSpeedKt,
  windDirection,
  circuit.upwindTrack
);

const crosswindGs = groundSpeedOnTrack(
  CLIMB_SPEED_KT,
  windSpeedKt,
  windDirection,
  circuit.crosswindTrack
);

const downwindGs = groundSpeedOnTrack(
  DOWNWIND_SPEED_KT,
  windSpeedKt,
  windDirection,
  circuit.downwindTrack
);

const baseGs = groundSpeedOnTrack(
  DESCENT_SPEED_KT,
  windSpeedKt,
  windDirection,
  circuit.baseTrack
);

  const turn1Delta = directedTurnDelta(upwindHeading, crosswindHeading, circuit.turnDir);
  const turn2Delta = directedTurnDelta(crosswindHeading, downwindHeading, circuit.turnDir);
  const turn3Delta = directedTurnDelta(downwindHeading, baseHeading, circuit.turnDir);
  const nominalFinalHeading =
    circuit.finalTrack +
    windCorrectionAngle(DESCENT_SPEED_KT, windSpeedKt, windDirection, circuit.finalTrack);
  const turn4Delta = directedTurnDelta(baseHeading, nominalFinalHeading, circuit.turnDir);

  const upwindRelative = windRelativeToTrack(windDirection, circuit.upwindTrack);
  const upwindHeadwind = windSpeedKt * Math.cos((upwindRelative * Math.PI) / 180);
  const upwindEffect =
    upwindHeadwind > 2
      ? "Headwind improves climb gradient. 700 ft AMSL will be reached earlier in ground distance."
      : upwindHeadwind < -2
      ? "Tailwind reduces climb gradient. 700 ft AMSL will be reached later in ground distance."
      : "Only a small along-track wind effect on climb. 700 ft AMSL will be reached close to normal ground distance.";

  const turn1Timing =
    upwindHeadwind > 2
      ? "Turn 1 should be started earlier than normal."
      : upwindHeadwind < -2
      ? "Turn 1 should be started later than normal."
      : "Turn 1 timing can stay close to normal.";

  const downwindAltitudeText =
    upwindHeadwind > 2
      ? "1300 ft may be reached early because the climb segment covers less ground."
      : upwindHeadwind < -2
      ? "Expect to reach 1300 ft later in ground distance because the departure segment stretches out."
      : "1300 ft should be reached close to normal spacing.";

  const runwayCrosswindText = crosswindSideText(windDirection, runwayHeading);
  const runwayAileronText = aileronIntoWindText(windDirection, runwayHeading);

  const runwayFinal = runwayResult(windDirection, windSpeedKt, runwayHeading);

  const pushText = eastWestPushText(windDirection, windSpeedKt);

  return [
    "UPWIND",
    `- ${upwindEffect}`,
    `- ${turn1Timing}`,
    `- On takeoff expect ${runwayCrosswindText}.`,
    `- Use ${runwayAileronText}.`,
    "- Rudder for P-factor still applies.",
    "",
    `TURN 1 (UPWIND → CROSSWIND)`,
    `- Turn ${turnDescription(turn1Delta)}.`,
    `- Roll out corrected into wind for the crosswind leg.`,
    "",
    "CROSSWIND",
    `- Required track: ${circuit.crosswindTrack}°.`,
    `- Heading: about ${round0(crosswindHeading)}° magnetic.`,
    `- Groundspeed: about ${round0(crosswindGs)} kt.`,
    "- Nose should point into wind to hold track.",
    "",
    `TURN 2 (CROSSWIND → DOWNWIND)`,
    `- Turn ${turnDescription(turn2Delta)}.`,
    `- Start the turn based on actual drift and rollout, not on a perfect square pattern.`,
    "- Bank 25° is standard, 30° may be used if needed and stable.",
    "",
    "DOWNWIND",
    `- Desired track: ${circuit.downwindTrack}°.`,
    `- Heading: about ${round0(downwindHeading)}° magnetic.`,
    `- Groundspeed: about ${round0(downwindGs)} kt.`,
    `- Wind tends to push the aircraft ${pushText}.`,
    `- ${downwindAltitudeText}`,
    `- ${descentPlanningText(downwindGs)}`,
    "",
    `TURN 3 (DOWNWIND → BASE)`,
    `- Turn ${turnDescription(turn3Delta)}.`,
    `- Usually begin this turn with drift in mind. If the aircraft is being carried ${pushText}, waiting too long will distort the base/final geometry.`,
    "",
    "BASE",
    `- Desired track: ${circuit.baseTrack}°.`,
    `- Heading: about ${round0(baseHeading)}° magnetic.`,
    `- Groundspeed: about ${round0(baseGs)} kt.`,
    "- Nose should again point into wind to hold track.",
    "",
    `TURN 4 (BASE → FINAL)`,
    `- Turn ${turnDescription(turn4Delta)}.`,
    "- Start the final turn early enough to roll out stable, not to chase final from outside.",
    `- ${finalTurnAltitudeText(windSpeedKt, runwayFinal.crosswindKt ?? 0)}`,
    `- On final expect ${runwayCrosswindText} and about ${runwayFinal.headwindKt} kt headwind / ${runwayFinal.crosswindKt} kt crosswind.`,
    "- Approach with crab, then straighten on short final.",
    `- Use ${runwayAileronText} and opposite rudder to align before touchdown.`,
    `- ${flapText(runwayFinal.crosswindKt ?? 0)}`,
  ].join("\n");
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
    const passwordInput = page
      .locator('input[type="password"], input[name="password"]')
      .first();

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

    const magneticWindDirection =
      wind.windDirection == null ? null : trueToMagnetic(wind.windDirection);

    const runway = chooseRunway(magneticWindDirection, wind.windSpeedKt);
    const probableRunwayChangeAt = findProbableRunwayChange(taf, runway.runway);
    const visualCircuitRecommendations = generateVisualCircuitRecommendations(
      runway.runway,
      runway.heading,
      magneticWindDirection,
      wind.windSpeedKt
    );

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
      windDirection: magneticWindDirection,
      windSpeedKt: wind.windSpeedKt,
      sourceUrl: process.env.LHNY_URL,
      fetchedAt: new Date().toISOString(),
      note: "Runway is a wind-based recommendation, not an official assigned runway.",
      visualCircuitRecommendations,
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