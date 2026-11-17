import React, { useEffect, useRef } from 'react';

export default function Waveform({ frameRef, active, paused }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    let raf;
    function draw() {
      const { width, height } = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      context.strokeStyle = '#665162'; context.lineWidth = 1;
      for (let x = 0; x < width; x += 22) { context.beginPath(); context.moveTo(x, height / 2 - 2); context.lineTo(x, height / 2 + 2); context.stroke(); }
      const wave = active && !paused ? frameRef.current?.waveform : null;
      context.beginPath(); context.lineWidth = 2;
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, '#9F796F'); gradient.addColorStop(0.5, '#F3B9A8'); gradient.addColorStop(1, '#B5A0D5');
      context.strokeStyle = gradient;
      if (wave?.length) {
        for (let x = 0; x < width; x += 2) {
          const sample = wave[Math.floor(x / width * wave.length)] || 0;
          const y = height / 2 + Math.max(-1, Math.min(1, sample * 2.5)) * height * 0.43;
          x === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
        }
      } else { context.moveTo(0, height / 2); context.lineTo(width, height / 2); }
      context.stroke(); raf = requestAnimationFrame(draw);
    }
    draw(); return () => cancelAnimationFrame(raf);
  }, [frameRef, active, paused]);
  return <canvas ref={canvasRef} className="waveform" role="img" aria-label={active ? 'Live microphone waveform' : 'Microphone waveform, inactive'} />;
}
