import React, { useState } from "react";
import {
  IconCheck,
  IconCopy,
  IconDeviceMobile,
  IconExternalLink,
  IconX,
} from "@tabler/icons-react";
import { QRCodeSvg } from "./QRCodeSvg";
import type { RemoteServerInfo } from "../../../player/useRemoteServer";
import styles from "./RemoteControlModal.module.css";

interface RemoteControlModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverInfo: RemoteServerInfo;
}

export const RemoteControlModal: React.FC<RemoteControlModalProps> = ({
  isOpen,
  onClose,
  serverInfo,
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const url = serverInfo.defaultUrl || `http://localhost:${serverInfo.port}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleOpenLocal = () => {
    window.open(url, "_blank");
  };

  return (
    <div className={styles.backdrop} onClick={onClose} role="dialog" aria-modal="true">
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <IconDeviceMobile size={22} color="#1ed760" />
            <span>Mobile Web Remote</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close modal">
            <IconX size={18} />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.statusPill}>
            <span className={styles.dot} />
            <span>Active on port {serverInfo.port}</span>
          </div>

          <div className={styles.qrContainer}>
            <QRCodeSvg value={url} size={180} />
          </div>

          <div className={styles.urlBox}>
            <input
              type="text"
              readOnly
              value={url}
              className={styles.urlInput}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button className={styles.copyBtn} onClick={handleCopy} title="Copy URL">
              {copied ? (
                <>
                  <IconCheck size={16} />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <IconCopy size={16} />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>

          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              color: "#b3b3b3",
              fontSize: "12px",
              display: "flex",
              alignItems: "center",
              gap: "4px",
              cursor: "pointer",
              padding: "4px 8px",
            }}
            onClick={handleOpenLocal}
          >
            <IconExternalLink size={14} />
            <span>Preview in web browser</span>
          </button>

          <div className={styles.instructions}>
            <div className={styles.instTitle}>How to connect your iPhone:</div>
            <ol className={styles.instList}>
              <li>Make sure your iPhone is on the <strong>same Wi-Fi network</strong>.</li>
              <li>Open your iPhone <strong>Camera</strong> and scan the QR code above.</li>
              <li>Or type the URL directly into <strong>Safari</strong> on your iPhone.</li>
              <li>In Safari, tap <strong>Share</strong> and choose <strong>"Add to Home Screen"</strong> for the full Spotify-like app experience!</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};
