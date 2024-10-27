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
  const [unstableObjects, setUnstableObjects] = useState(new Set());
  const [ignoredLocations, setIgnoredLocations] = useState(new Set());
  const unstableTimeoutRef = useRef({});

  let frameCount = 0;
  let lastTime = Date.now();
  const BACKEND_URL = "https://192.168.137.154:5000";

  const updateShoppingCart = useCallback((tracked, confirmed) => {
    // Create a new cart state combining currently tracked confirmed items
    // and previously confirmed items that are no longer in frame
    const newCart = { ...confirmed };

    // Add newly confirmed items that are still in frame
    tracked.forEach((obj) => {
      if (obj.status === "confirmed") {
        const itemName = obj.class;
        if (!newCart[itemName]) {
          newCart[itemName] = {
            quantity: 1,
            unit_price: 0, // Will be updated when backend sends the details
            image_path: "",
          };
        } else {
          newCart[itemName].quantity += 1;
        }
        // Update last confirmed time for this object
        lastConfirmedTimeRef.current[obj.id] = Date.now();
      }
    });

    setConfirmedObjects(newCart);
  }, []);

  useEffect(() => {
    const socket = io(BACKEND_URL, {
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

    socket.on("connect_error", (error) => {
      console.log("Connection Error:", error);
    });

    socket.on("disconnect", (reason) => {
      console.log("Disconnected:", reason);
    });

    socket.on("detection_results", (data) => {
      const img = new Image();
      img.onload = () => {
        drawDetections(img, data.tracked_objects);
        updateFPS();
      };
      img.src = URL.createObjectURL(
        new Blob([data.frame], { type: "image/jpeg" })
      );

      setUnstableObjects(new Set(data.unstable_objects || []));
      // Update tracked objects and trigger cart update
      setTrackedObjects(data.tracked_objects || []);
      updateShoppingCart(
        data.tracked_objects || [],
        data.confirmed_objects || {}
      );
      setUndeterminedObjects(data.undetermined_objects || []);

      // Update scan start time if needed
      if (data.tracked_objects?.length > 0 && !scanStartTimeRef.current) {
        scanStartTimeRef.current = Date.now();
      } else if (data.tracked_objects?.length === 0) {
        scanStartTimeRef.current = null;
      }
    });

    return () => socket.disconnect();
  }, [updateShoppingCart]);

  useEffect(() => {
    const newInstruction = getContextualInstructions();
    if (newInstruction !== lastInstructionRef.current) {
      setInstruction(newInstruction);
      speakInstruction(newInstruction);
      lastInstructionRef.current = newInstruction;
    }

    // Calculate total price
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
    const unstableInFrame = trackedObjects.filter((obj) =>
      unstableObjects.has(obj.location_hash)
    );
    const currentTime = Date.now();

    if (unstableInFrame.length > 0) {
      return "We're experiencing difficulties identifying some items. Please reposition them or click 'Ignore' below their bounding boxes to exclude them from scanning.";
    }

    // No items in scanning area
    if (itemsInFrame === 0) {
      return "Please place items in the scanning area. Make sure everything is spread out and visible for the camera.";
    }

    // Check for items taking too long (10 seconds) with no confirmations
    if (
      scanStartTimeRef.current &&
      currentTime - scanStartTimeRef.current > 10000 &&
      confirmedInFrame.length === 0
    ) {
      return "Items are taking longer than usual to confirm. Please reposition the yellow-boxed items to ensure they're clearly visible to the camera. If you believe we have detected something wrong, click the help button and an assistant will come help you right away. Sorry for this inconvenience.";
    }

    // Check if we have both confirmed and undetermined items for more than 3 seconds
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

    // All items in current frame are confirmed
    if (undeterminedInFrame.length === 0 && confirmedInFrame.length > 0) {
      return "All items confirmed. Place items into the bagging area and continue to scan or proceed with payment.";
    }

    // Default scanning message
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

  const handleIgnoreLocation = (locationHash) => {
    setIgnoredLocations((prev) => new Set([...prev, locationHash]));
    // Clear any unstable timeout for this location
    if (unstableTimeoutRef.current[locationHash]) {
      clearTimeout(unstableTimeoutRef.current[locationHash]);
      delete unstableTimeoutRef.current[locationHash];
    }
  };

  const drawDetections = (img, trackedObjects) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    trackedObjects.forEach((obj) => {
      // Skip drawing ignored locations
      if (ignoredLocations.has(obj.location_hash)) return;

      const [x1, y1, x2, y2] = obj.bbox;
      const isUnstable = unstableObjects.has(obj.location_hash);
      const color = isUnstable
        ? "#ef4444" // Red for unstable
        : obj.status === "confirmed"
        ? "#22c55e" // Green for confirmed
        : "#eab308"; // Yellow for undetermined

      // Draw box
      ctx.strokeStyle = color;
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

      // Draw background with rounded corners
      ctx.fillStyle = color;
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
        const progress = obj.progress || 0;

        // Background
        ctx.fillStyle = "rgba(239, 68, 68, 0.5)"; // Red background
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

        // Progress
        ctx.fillStyle = "rgba(34, 197, 94, 0.9)"; // Green progress
        ctx.beginPath();
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
      // Draw ignore button for unstable detections
      if (isUnstable && obj.unstable_duration > 5) {
        // Only show ignore button after 5 seconds of instability
        const buttonWidth = 60;
        const buttonHeight = 24;
        const buttonX = x1;
        const buttonY = y2 + 10;

        // Draw button background
        ctx.fillStyle = "rgba(239, 68, 68, 0.8)";
        roundRect(ctx, buttonX, buttonY, buttonWidth, buttonHeight, 4);
        ctx.fill();

        // Draw button text
        ctx.fillStyle = "#ffffff";
        ctx.font = "12px Arial";
        ctx.fillText("Ignore", buttonX + 12, buttonY + 16);

        // Store button coordinates for click handling
        obj.ignoreButton = {
          x: buttonX,
          y: buttonY,
          width: buttonWidth,
          height: buttonHeight,
        };
      }
    });
  };

  // Add click handler for ignore buttons
  const handleCanvasClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    trackedObjects.forEach((obj) => {
      if (obj.ignoreButton) {
        const button = obj.ignoreButton;
        if (
          x * scaleX >= button.x &&
          x * scaleX <= button.x + button.width &&
          y * scaleY >= button.y &&
          y * scaleY <= button.y + button.height
        ) {
          handleIgnoreLocation(obj.location_hash);
        }
      }
    });
  };

  // Helper function to draw rounded rectangles
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

  const updateFPS = () => {
    frameCount++;
    const currentTime = Date.now();
    if (currentTime - lastTime >= 1000) {
      setFps(frameCount);
      frameCount = 0;
      lastTime = currentTime;
    }
  };

  const handleCheckout = () => {
    // Implement checkout logic here
    console.log("Proceeding to checkout");
  };

  // Add canvas click listener
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.addEventListener("click", handleCanvasClick);
      return () => canvas.removeEventListener("click", handleCanvasClick);
    }
  }, [trackedObjects]);

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
