import React, { useEffect, useRef, useState, useCallback } from "react";
import io from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";

const LiveDetection = () => {
  const canvasRef = useRef(null);
  const [fps, setFps] = useState(0);
  const [confirmedObjects, setConfirmedObjects] = useState({});
  const [undeterminedObjects, setUndeterminedObjects] = useState([]);
  const [trackedObjects, setTrackedObjects] = useState([]);
  const [instruction, setInstruction] = useState("");
  const [totalPrice, setTotalPrice] = useState(0);
  const lastInstructionRef = useRef("");
  const lastConfirmedTimeRef = useRef({});
  const scanStartTimeRef = useRef(null);
  const socketRef = useRef(null);

  let frameCount = 0;
  let lastTime = Date.now();

  const BACKEND_URL = "https://192.168.137.154:5000";

  const updateShoppingCart = useCallback((tracked, confirmed) => {
    const newCart = { ...confirmed };
    tracked.forEach((obj) => {
      if (obj.status === "confirmed") {
        const itemName = obj.class;
        if (!newCart[itemName]) {
          newCart[itemName] = {
            quantity: 1,
            unit_price: 0,
            image_path: "",
          };
        } else {
          newCart[itemName].quantity += 1;
        }
        lastConfirmedTimeRef.current[obj.id] = Date.now();
      }
    });
    setConfirmedObjects(newCart);
  }, []);

  useEffect(() => {
    socketRef.current = io(BACKEND_URL, {
      secure: true,
      rejectUnauthorized: false,
      transports: ["websocket", "polling"],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 60000,
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    socketRef.current.on("connect_error", (error) => {
      console.log("Connection Error:", error);
    });

    socketRef.current.on("disconnect", (reason) => {
      console.log("Disconnected:", reason);
    });

    socketRef.current.on("detection_results", (data) => {
      const img = new Image();
      img.onload = () => {
        drawDetections(img, data.tracked_objects);
        updateFPS();
      };
      img.src = URL.createObjectURL(
        new Blob([data.frame], { type: "image/jpeg" })
      );

      setTrackedObjects(data.tracked_objects || []);
      updateShoppingCart(
        data.tracked_objects || [],
        data.confirmed_objects || {}
      );
      setUndeterminedObjects(data.undetermined_objects || []);

      if (data.tracked_objects?.length > 0 && !scanStartTimeRef.current) {
        scanStartTimeRef.current = Date.now();
      } else if (data.tracked_objects?.length === 0) {
        scanStartTimeRef.current = null;
      }
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [updateShoppingCart]);

  useEffect(() => {
    const newInstruction = getContextualInstructions();
    if (newInstruction !== lastInstructionRef.current) {
      setInstruction(newInstruction);
      speakInstruction(newInstruction);
      lastInstructionRef.current = newInstruction;
    }

    const total = Object.entries(confirmedObjects).reduce(
      (sum, [_, item]) => sum + item.quantity * (item.unit_price || 0),
      0
    );
    setTotalPrice(total);
  }, [confirmedObjects, undeterminedObjects, trackedObjects]);

  const getContextualInstructions = () => {
    const itemsInFrame = trackedObjects.length;
    const confirmedInFrame = trackedObjects.filter(
      (obj) => obj.status === "confirmed"
    );
    const undeterminedInFrame = trackedObjects.filter(
      (obj) => obj.status === "undetermined"
    );
    const currentTime = Date.now();

    if (itemsInFrame === 0) {
      return "Please place items in the scanning area. Make sure everything is spread out and visible for the camera.";
    }

    if (
      scanStartTimeRef.current &&
      currentTime - scanStartTimeRef.current > 10000 &&
      confirmedInFrame.length === 0
    ) {
      return "Items are taking longer than usual to confirm. Please reposition the yellow-boxed items to ensure they're clearly visible to the camera.";
    }

    if (confirmedInFrame.length > 0 && undeterminedInFrame.length > 0) {
      const oldestConfirmation = Math.min(
        ...confirmedInFrame.map(
          (obj) => lastConfirmedTimeRef.current[obj.id] || currentTime
        )
      );
      if (currentTime - oldestConfirmation > 3000) {
        return "Please place confirmed items in the bagging area to clear the scanning area, then reposition the yellow-boxed items for better detection.";
      }
    }

    if (undeterminedInFrame.length === 0 && confirmedInFrame.length > 0) {
      return "All items confirmed. Place items into the bagging area and continue to scan or proceed with payment.";
    }

    return "Scanning in progress. Please keep items steady...";
  };

  const speakInstruction = (text) => {
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      speechSynthesis.speak(utterance);
    }
  };

  const roundRect = (ctx, x, y, width, height, radius) => {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  };

  const drawDetections = (img, trackedObjects) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    trackedObjects.forEach((obj) => {
      const [x1, y1, x2, y2] = obj.bbox;
      const color = obj.status === "confirmed" ? "#22c55e" : "#eab308";

      // Draw box
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      // Draw label
      const text = `${obj.class} ${(obj.confidence * 100).toFixed(1)}%`;
      ctx.font = "16px Arial";
      const textWidth = ctx.measureText(text).width;
      const padding = 4;
      let textX = x1;
      let textY = y1 - 5;

      if (textY < 20) textY = y2 + 20;
      if (textX + textWidth > canvas.width) {
        textX = canvas.width - textWidth - padding;
      }

      // Draw label background
      ctx.fillStyle = color;
      roundRect(
        ctx,
        textX - padding,
        textY - 20,
        textWidth + padding * 2,
        24,
        4
      );
      ctx.fill();

      // Draw label text
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, textX, textY - 4);

      // Draw progress bar for undetermined objects
      if (obj.status === "undetermined") {
        const progressBarHeight = 4;
        const progressBarY = y2 + 5;
        const progressBarWidth = x2 - x1;
        const progress = obj.progress || 0;

        // Background
        ctx.fillStyle = "rgba(239, 68, 68, 0.5)";
        roundRect(
          ctx,
          x1,
          progressBarY,
          progressBarWidth,
          progressBarHeight,
          2
        );
        ctx.fill();

        // Progress
        ctx.fillStyle = "rgba(34, 197, 94, 0.9)";
        roundRect(
          ctx,
          x1,
          progressBarY,
          (progressBarWidth * progress) / 100,
          progressBarHeight,
          2
        );
        ctx.fill();
      }
    });
  };

  const updateFPS = () => {
    frameCount++;
    const currentTime = Date.now();
    if (currentTime - lastTime >= 1000) {
      setFps(frameCount);
      frameCount = 0;
      lastTime = currentTime;
    }
  };

  return (
    <div className="flex h-screen bg-gray-100">
      <div className="flex-1 flex flex-col">
        <div className="relative flex-1 bg-black">
          <canvas
            ref={canvasRef}
            className="absolute top-0 left-0 w-full h-full object-contain"
          />
          <div className="absolute top-4 left-4 bg-black/50 text-white px-2 py-1 rounded">
            FPS: {fps}
          </div>
        </div>
        <div className="bg-white p-4 shadow-lg">
          <div className="text-lg font-semibold text-gray-800">
            {instruction}
          </div>
        </div>
      </div>
      <div className="w-96 bg-white shadow-lg p-4 overflow-y-auto">
        <h2 className="text-2xl font-bold mb-4">Shopping Cart</h2>
        {Object.entries(confirmedObjects).map(([itemName, item]) => (
          <div
            key={itemName}
            className="flex items-center justify-between mb-4 p-2 bg-gray-50 rounded"
          >
            <div>
              <div className="font-semibold">{itemName}</div>
              <div className="text-sm text-gray-600">
                Quantity: {item.quantity}
              </div>
            </div>
            <div className="text-right">
              <div>${item.unit_price?.toFixed(2) || "N/A"}</div>
              <div className="font-semibold">
                ${(item.quantity * (item.unit_price || 0)).toFixed(2)}
              </div>
            </div>
          </div>
        ))}
        <div className="mt-4 pt-4 border-t">
          <div className="flex justify-between items-center mb-4">
            <span className="text-xl font-bold">Total:</span>
            <span className="text-xl font-bold">${totalPrice.toFixed(2)}</span>
          </div>
          <button
            onClick={() => console.log("Proceeding to checkout")}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Proceed to Checkout
          </button>
        </div>
      </div>
    </div>
  );
};

export default LiveDetection;
