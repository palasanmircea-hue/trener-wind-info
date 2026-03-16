"use client";

import { useEffect, useState } from "react";

type WeatherData = {
  station: string;
  rawMetar: string;
  rawTaf: string;
  decodedMetar: string;
  decodedTaf: string;
  runwayInUse: string;
  headwindKt: number | null;
  crosswindKt: number | null;
  windDirection: number | null;
  windSpeedKt: number | null;
  sourceUrl: string;
  fetchedAt: string;
  note: string;
  probableRunwayChangeAt: string | null;
};

export default function HomePage() {
 const [data, setData] = useState<WeatherData | null>(null);
const [loading, setLoading] = useState(true);
const [refreshing, setRefreshing] = useState(false);
const [error, setError] = useState<string | null>(null);

 async function load(background = false) {
  try {
    if (background) {
      setRefreshing(true);
    } else if (!data) {
      setLoading(true);
    }

    setError(null);

    const res = await fetch("/api/weather", { cache: "no-store" });
    const text = await res.text();

    let json: WeatherData | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Server returned invalid response.");
    }

    if (!res.ok) {
      throw new Error((json as any)?.error || `HTTP ${res.status}`);
    }

    setData(json);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Unknown error");
  } finally {
    setLoading(false);
    setRefreshing(false);
  }
}

 useEffect(() => {
  load(false);

  const interval = setInterval(() => {
    load(true);
  }, 120000);

  return () => clearInterval(interval);
}, []);

  return (
   <main
  style={{
    minHeight: "100vh",
    background: "#eef3f9",
    fontFamily: "Arial, sans-serif",
    padding: "20px",
    color: "#0f172a"
  }}
>
      <div
        style={{
          maxWidth: "900px",
          margin: "0 auto",
        }}
      >
        <div style={{ marginBottom: "24px" }}>
  <h1
    style={{
      fontSize: "48px",
      fontWeight: 800,
      color: "#0d3b82",
      letterSpacing: "0.5px",
      marginBottom: "4px",
    }}
  >
    TRENER WIND INFO
  </h1>

  <div
    style={{
      fontSize: "14px",
      color: "#64748b",
      fontWeight: 500,
    }}
  >
    Built by Mircea Palasan - Wizz Air Pilot Academy
  </div>
</div>
{refreshing && data && (
  <div
    style={{
      marginBottom: "18px",
      color: "#5b6b7f",
      fontWeight: 600,
    }}
  >
    Refreshing weather...
  </div>
)}
       {loading && !data && (
  <div style={cardStyle}>
    <p style={{ margin: 0 }}>Loading weather...</p>
  </div>
)}

        {error && (
          <div style={{ ...cardStyle, border: "1px solid #f1b5b5", color: "#b42318" }}>
            <p style={{ margin: 0 }}>{error}</p>
          </div>
        )}

        {data && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "14px",
                marginBottom: "18px",
              }}
            >
              <InfoCard label="Station" value={data.station} />
              <div style={cardStyle}>
  <div
    style={{
      fontSize: "14px",
      color: "#5b6b7f",
      marginBottom: "8px",
      fontWeight: 600,
    }}
  >
    Runway
  </div>

  <div
    style={{
      fontSize: "28px",
      fontWeight: 800,
      color: "#0d3b82",
      marginBottom: "4px",
    }}
  >
    {data.runwayInUse}
  </div>

  <div
    style={{
      fontSize: "13px",
      color: "#64748b",
    }}
  >
    {data.probableRunwayChangeAt ?? "No runway change indicated in current TAF"}
  </div>
</div>
              <InfoCard
                label="Headwind"
                value={data.headwindKt != null ? `${data.headwindKt} kt` : "-"}
              />
              <InfoCard
                label="Crosswind"
                value={data.crosswindKt != null ? `${data.crosswindKt} kt` : "-"}
              />
            </div>

            <div style={{ ...cardStyle, marginBottom: "18px" }}>
              <h2 style={sectionTitle}>Current wind info</h2>
              <div style={rowStyle}>
                <span style={labelStyle}>Wind direction</span>
                <span>{data.windDirection ?? "-"}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Wind speed</span>
                <span>{data.windSpeedKt ?? "-"} kt</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Last updated</span>
                <span>{new Date(data.fetchedAt).toLocaleString()}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Note</span>
                <span>{data.note}</span>
              </div>
            </div>

            <div style={{ ...cardStyle, marginBottom: "18px" }}>
              <h2 style={sectionTitle}>METAR</h2>
              <div style={{ marginBottom: "14px" }}>
                <div style={smallTitle}>Raw</div>
                <div style={codeBoxStyle}>{data.rawMetar}</div>
              </div>
              <div>
                <div style={smallTitle}>Decoded</div>
                <div style={textBoxStyle}>{data.decodedMetar}</div>
              </div>
            </div>

            <div style={cardStyle}>
              <h2 style={sectionTitle}>TAF</h2>
              <div style={{ marginBottom: "14px" }}>
                <div style={smallTitle}>Raw</div>
                <div style={codeBoxStyle}>{data.rawTaf}</div>
              </div>
              <div>
                <div style={smallTitle}>Decoded</div>
                <div style={textBoxStyle}>{data.decodedTaf}</div>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={cardStyle}>
      <div
        style={{
          fontSize: "14px",
          color: "#5b6b7f",
          marginBottom: "8px",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "28px",
          fontWeight: 800,
          color: "#0d3b82",
        }}
      >
        {value}
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: "16px",
  padding: "18px",
  boxShadow: "0 6px 18px rgba(13, 59, 130, 0.08)",
  border: "1px solid #dbe5f0",
};

const sectionTitle: React.CSSProperties = {
  margin: "0 0 14px 0",
  fontSize: "24px",
  fontWeight: 800,
  color: "#102a43",
};

const smallTitle: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 700,
  color: "#5b6b7f",
  marginBottom: "8px",
};

const labelStyle: React.CSSProperties = {
  fontWeight: 700,
  color: "#334e68",
  minWidth: "120px",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: "12px",
  padding: "8px 0",
  borderBottom: "1px solid #edf2f7",
  flexWrap: "wrap",
};

const codeBoxStyle: React.CSSProperties = {
  background: "#f7fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "12px",
  fontFamily: "monospace",
  lineHeight: 1.5,
  wordBreak: "break-word",
  color: "#111827"
};

const textBoxStyle: React.CSSProperties = {
  background: "#fbfdff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "12px",
  lineHeight: 1.7,
  whiteSpace: "pre-line",
  color: "#111827"
};