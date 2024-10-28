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
  const [frameStatus, setFrameStatus] = useState({
    is_empty: true,
    empty_confidence: 1.0,
  }); // Add this line

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
      setFrameStatus(
        data.frame_status || { is_empty: true, empty_confidence: 1.0 }
      ); // Add this line

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
    const itemsInFrame = trackedObjects.filter(
      (obj) => obj.is_valid || obj.status === "confirmed"
    ).length;
    const confirmedInFrame = trackedObjects.filter(
      (obj) => obj.status === "confirmed"
    );
    const undeterminedInFrame = trackedObjects.filter(
      (obj) => obj.status === "undetermined" && obj.is_valid
    );
    const currentTime = Date.now();

    // No items in scanning area - now uses frame_status
    if (frameStatus.is_empty || itemsInFrame === 0) {
      return "Please place items in the scanning area. Make sure everything is spread out and visible for the camera.";
    }

    if (
      scanStartTimeRef.current &&
      currentTime - scanStartTimeRef.current > 10000 &&
      confirmedInFrame.length === 0
    ) {
      return "Items are taking longer than usual to confirm. Please reposition the yellow-boxed items to ensure they're clearly visible to the camera. If you believe we have detected something wrong, click the help button and an assistant will come help you right away. Sorry for this inconvenience.";
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
      // Only draw objects that are valid or confirmed
      if (!obj.is_valid && obj.status !== "confirmed") return;

      const [x1, y1, x2, y2] = obj.bbox;
      const color = obj.status === "confirmed" ? "#22c55e" : "#eab308";

      // Adjust opacity based on stability
      const opacity = obj.stability ? Math.max(0.3, obj.stability) : 1;
      const strokeColor = `${color}${Math.round(opacity * 255)
        .toString(16)
        .padStart(2, "0")}`;

      // Draw box with stability-based opacity
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      // Draw label background
      const text = `${obj.class} ${(obj.confidence * 100).toFixed(1)}%`;
      ctx.font = "16px Arial";
      const textWidth = ctx.measureText(text).width;
      const padding = 4;

      // Position text and background
      let textX = x1;
      let textY = y1 - 5;
      if (textY < 20) textY = y2 + 20;
      if (textX + textWidth > canvas.width)
        textX = canvas.width - textWidth - padding;

      // Draw background with rounded corners and stability-based opacity
      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      const backgroundHeight = 24;
      const radius = 4;
      roundRect(
        ctx,
        textX - padding,
        textY - 20,
        textWidth + padding * 2,
        backgroundHeight,
        radius
      );
      ctx.fill();

      // Draw text
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, textX, textY - 4);

      // Draw progress bar for undetermined objects
      if (obj.status === "undetermined") {
        const progressBarHeight = 4;
        const progressBarY = y2 + 5;
        const progressBarWidth = x2 - x1;

        // Draw stability bar instead of simple progress
        const progress = obj.progress || 0;
        const stability = obj.stability || 0;

        // Background
        ctx.fillStyle = "rgba(239, 68, 68, 0.5)";
        ctx.beginPath();
        roundRect(
          ctx,
          x1,
          progressBarY,
          progressBarWidth,
          progressBarHeight,
          2
        );
        ctx.fill();

        // Progress with stability influence
        const effectiveProgress = progress * stability;
        ctx.fillStyle = "rgba(34, 197, 94, 0.9)";
        ctx.beginPath();
        roundRect(
          ctx,
          x1,
          progressBarY,
          (progressBarWidth * effectiveProgress) / 100,
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
    <div className="flex flex-col h-screen bg-gray-100">
      <div className="bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-4 mb-4">
        <p className="font-bold">Instructions:</p>
        <p>{instruction}</p>
      </div>
      <div className="flex flex-grow">
        <div className="w-1/2 p-4 flex flex-col">
          <h2 className="text-2xl font-bold mb-4">Live Detection</h2>
          <div className="relative flex-grow">
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 w-full h-full object-contain"
            />
          </div>
          <div className="mt-2">FPS: {fps}</div>
        </div>
        <div className="w-1/2 p-4 flex flex-col">
          <h2 className="text-2xl font-bold mb-4">Shopping Cart</h2>
          <div className="flex-grow overflow-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-200">
                  <th className="p-2">Image</th>
                  <th className="p-2">Item Name</th>
                  <th className="p-2">Quantity</th>
                  <th className="p-2">Unit Price</th>
                  <th className="p-2">Total Price</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {Object.entries(confirmedObjects).map(([itemName, item]) => (
                    <motion.tr
                      key={itemName}
                      initial={{ opacity: 0, y: -20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 20 }}
                      transition={{ duration: 0.3 }}
                      className="border-b"
                    >
                      <td className="p-2">
                        <img
                          src={`${BACKEND_URL}/Assets/${item.image_path
                            .split("/")
                            .pop()}`}
                          alt={itemName}
                          className="w-16 h-16 object-cover rounded-lg"
                        />
                      </td>
                      <td className="p-2 font-medium">{itemName}</td>
                      <td className="p-2 text-center">{item.quantity}</td>
                      <td className="p-2 text-right">
                        ${item.unit_price?.toFixed(2) || "N/A"}
                      </td>
                      <td className="p-2 text-right font-medium">
                        ${(item.quantity * (item.unit_price || 0)).toFixed(2)}
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
          <div className="mt-4 p-4 bg-white rounded-lg shadow-sm">
            <div className="text-xl font-bold text-right">
              Total: ${totalPrice.toFixed(2)}
            </div>
            <button
              onClick={handleCheckout}
              disabled={undeterminedObjects.length > 0}
              className={`mt-4 w-full p-3 text-white font-bold rounded-lg transition-all duration-200 ${
                undeterminedObjects.length > 0
                  ? "bg-gray-400 cursor-not-allowed"
                  : "bg-blue-500 hover:bg-blue-600 active:bg-blue-700"
              }`}
            >
              {undeterminedObjects.length > 0
                ? "Please wait for all items to be confirmed"
                : "Proceed to Checkout"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LiveDetection;
