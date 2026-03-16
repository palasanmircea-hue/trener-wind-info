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
};

export default function HomePage() {
  const [data, setData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch("/api/weather", { cache: "no-store" });
const text = await res.text();

let json: any = null;
try {
  json = text ? JSON.parse(text) : null;
} catch {
  throw new Error(`Server returned invalid response: ${text.slice(0, 200)}`);
}

if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);

setData(json);

      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

 useEffect(() => {
  load();

  const interval = setInterval(() => {
    load();
  }, 60000);

  return () => clearInterval(interval);
}, []);

  return (
    <main
  style={{
    fontFamily: "Arial, sans-serif",
    padding: "40px",
    maxWidth: "1000px",
    margin: "0 auto",
    lineHeight: 1.6,
    background: "#f3f6fb",
    minHeight: "100vh",
  }}
>
     <h1
  style={{
    fontSize: "44px",
    fontWeight: "bold",
    marginBottom: "30px",
    color: "#0b2c5f",
    letterSpacing: "0.5px",
  }}
>
  TRENER WIND INFO
</h1>

      {loading && <p>Loading weather...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {data && (
        <>
          <div
           style={{
  marginBottom: "30px",
  padding: "24px",
  border: "1px solid #d7e0ef",
  borderRadius: "14px",
  backgroundColor: "#ffffff",
  boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
}}
          >
            <h2 style={{ marginTop: 0, marginBottom: "15px" }}>Runway and wind</h2>
            <p><strong>Station:</strong> {data.station}</p>
            <p><strong>Runway:</strong> {data.runwayInUse}</p>
            <p><strong>Headwind:</strong> {data.headwindKt} kt</p>
            <p><strong>Crosswind:</strong> {data.crosswindKt} kt</p>
            <p><strong>Last updated:</strong> {new Date(data.fetchedAt).toLocaleString()}</p>
          </div>

          <div
          style={{
  marginBottom: "30px",
  padding: "24px",
  border: "1px solid #d7e0ef",
  borderRadius: "14px",
  backgroundColor: "#ffffff",
  boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
}}
          >
            <h2 style={{ marginTop: 0 }}>METAR</h2>
            <p><strong>Raw:</strong></p>
            <p>{data.rawMetar}</p>

            <p style={{ marginTop: "20px" }}><strong>Decoded:</strong></p>
            <p style={{ whiteSpace: "pre-line" }}>{data.decodedMetar}</p>
          </div>

          <div
          style={{
  marginBottom: "30px",
  padding: "24px",
  border: "1px solid #d7e0ef",
  borderRadius: "14px",
  backgroundColor: "#ffffff",
  boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
}}
          >
            <h2 style={{ marginTop: 0 }}>TAF</h2>
            <p><strong>Raw:</strong></p>
            <p>{data.rawTaf}</p>

            <p style={{ marginTop: "20px" }}><strong>Decoded:</strong></p>
            <p style={{ whiteSpace: "pre-line" }}>{data.decodedTaf}</p>
          </div>
        </>
      )}
    </main>
  );
}