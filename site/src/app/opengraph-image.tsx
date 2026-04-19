import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const OgImage = () =>
  new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#1a1a2e",
          color: "#e8e8e8",
          fontFamily: "monospace",
        }}
      >
        {/* Grid overlay */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)",
            backgroundSize: "64px 64px",
            display: "flex",
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* Badge */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "16px",
              color: "#34d399",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            v0.1.0
          </div>

          {/* Title */}
          <div style={{ display: "flex", fontSize: "72px", fontWeight: 700 }}>
            <span>safe</span>
            <span style={{ color: "#34d399" }}>script</span>
          </div>

          {/* Description */}
          <div
            style={{
              fontSize: "28px",
              color: "#a0a0b8",
              maxWidth: "800px",
              lineHeight: 1.4,
              display: "flex",
            }}
          >
            A programming language for AI agents. Static DAGs, formal data-flow
            tracking, and resource bounds you can inspect before anything runs.
          </div>

          {/* Signature preview line */}
          <div
            style={{
              display: "flex",
              gap: "24px",
              marginTop: "16px",
              fontSize: "18px",
              color: "#6b7280",
            }}
          >
            <span>
              envReads: {"{"}&quot;timestamp&quot;{"}"}
            </span>
            <span style={{ color: "#34d399" }}>|</span>
            <span>
              hosts: {"{"}&quot;api.example.com&quot;{"}"}
            </span>
            <span style={{ color: "#34d399" }}>|</span>
            <span>dataFlow: param:userId → host</span>
          </div>
        </div>
      </div>
    ),
    { ...size }
  );

export { OgImage as default };
