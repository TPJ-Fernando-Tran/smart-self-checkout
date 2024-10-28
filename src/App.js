import React, { useEffect, useRef, useState, useCallback } from "react";
import io from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";

const QuantityAdjuster = ({
  itemName,
  currentQuantity,
  originalQuantity,
  unitPrice,
  onAdjust,
  onRequestAssistance,
  onSpeak,
  onReset,
  isManuallyAdjusted,
}) => {
  const [isAdjusting, setIsAdjusting] = useState(false);

  const handleAdjust = (newQuantity) => {
    const change = newQuantity - currentQuantity;
    const decreaseAmount = -change * unitPrice;

    if (newQuantity < originalQuantity && decreaseAmount > 5) {
      onRequestAssistance(itemName, currentQuantity, newQuantity);
      return;
    }

    if (newQuantity !== currentQuantity) {
      onAdjust(itemName, newQuantity);
    }
  };

  const startAdjusting = () => {
    setIsAdjusting(true);
    onSpeak(
      "You're trying to change the quantity of this item. Please note that this scanning session will be recorded to ensure the integrity of the process."
    );
  };

  return (
    <div className="flex items-center space-x-2">
      {!isAdjusting ? (
        <div className="flex items-center space-x-2">
          <button
            onClick={startAdjusting}
            className="text-blue-600 hover:text-blue-800"
          >
            Adjust
          </button>
          {isManuallyAdjusted && (
            <button
              onClick={() => {
                onReset(itemName);
                onSpeak("Quantity reset to automatic detection.");
              }}
              className="text-xs text-gray-500 hover:text-gray-700"
              title="Reset to detected quantity"
            >
              Reset
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center space-x-2">
          <button
            onClick={() => handleAdjust(currentQuantity - 1)}
            className="p-1 text-gray-600 hover:text-gray-800"
            disabled={currentQuantity <= 0}
          >
            -
          </button>
          <span className="min-w-[2rem] text-center">{currentQuantity}</span>
          <button
            onClick={() => handleAdjust(currentQuantity + 1)}
            className="p-1 text-gray-600 hover:text-gray-800"
          >
            +
          </button>
          <button
            onClick={() => setIsAdjusting(false)}
            className="ml-2 text-sm text-gray-500 hover:text-gray-700"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
};

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
  });
  const [processingItems, setProcessingItems] = useState(new Set());
  const [showAssistanceModal, setShowAssistanceModal] = useState(false);
  const [adjustmentMessage, setAdjustmentMessage] = useState("");
  const [originalQuantities, setOriginalQuantities] = useState({});
  const [manualAdjustments, setManualAdjustments] = useState({});

  let frameCount = 0;
  let lastTime = Date.now();

  const BACKEND_URL = "https://192.168.137.154:5000";

  // Update the updateShoppingCart function to respect manual adjustments
  const updateShoppingCart = useCallback(
    (tracked, confirmed) => {
      const newCart = { ...confirmed };

      // First, process the confirmed detections
      tracked.forEach((obj) => {
        if (obj.status === "confirmed") {
          const itemName = obj.class;
          // Only update quantities for items that haven't been manually adjusted
          if (!manualAdjustments[itemName]) {
            if (!newCart[itemName]) {
              newCart[itemName] = {
                quantity: 1,
                unit_price: 0,
                image_path: "",
              };
              // Store original quantity
              setOriginalQuantities((prev) => ({
                ...prev,
                [itemName]: 1,
              }));
            } else {
              newCart[itemName].quantity += 1;
              setOriginalQuantities((prev) => ({
                ...prev,
                [itemName]: (prev[itemName] || 0) + 1,
              }));
            }
            lastConfirmedTimeRef.current[obj.id] = Date.now();
          }
        }
      });

      // Preserve manually adjusted quantities
      Object.entries(manualAdjustments).forEach(([itemName, quantity]) => {
        if (newCart[itemName]) {
          newCart[itemName] = {
            ...newCart[itemName],
            quantity: quantity,
          };
        }
      });

      setConfirmedObjects(newCart);
    },
    [manualAdjustments]
  );

  // Update the handleQuantityAdjust function in LiveDetection
  const handleQuantityAdjust = (itemName, newQuantity) => {
    const item = confirmedObjects[itemName];
    const originalQuantity = originalQuantities[itemName];

    if (newQuantity < item.quantity) {
      // Reducing quantity
      speakInstruction(
        "Please ensure you have returned the item to its original location. Random audits may be conducted to verify inventory accuracy."
      );
    }

    // Store the manual adjustment
    setManualAdjustments((prev) => ({
      ...prev,
      [itemName]: newQuantity,
    }));

    setConfirmedObjects((prev) => ({
      ...prev,
      [itemName]: {
        ...prev[itemName],
        quantity: newQuantity,
        _previousQuantity: item.quantity,
      },
    }));

    // Recalculate total price
    const updatedTotal = Object.entries({
      ...confirmedObjects,
      [itemName]: { ...item, quantity: newQuantity },
    }).reduce(
      (sum, [_, item]) => sum + item.quantity * (item.unit_price || 0),
      0
    );
    setTotalPrice(updatedTotal);
  };

  // Add a function to reset manual adjustment if needed
  const resetManualAdjustment = (itemName) => {
    setManualAdjustments((prev) => {
      const newAdjustments = { ...prev };
      delete newAdjustments[itemName];
      return newAdjustments;
    });
  };

  const handleRequestAssistance = (itemName, currentQty, requestedQty) => {
    setAdjustmentMessage(
      `Assistance needed: Customer wants to reduce ${itemName} quantity from ${currentQty} to ${requestedQty}. This exceeds the $5 limit for self-service adjustments.`
    );
    setShowAssistanceModal(true);
    speakInstruction(
      "This adjustment requires assistance. An associate will be with you shortly."
    );
  };

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
      console.log("Received tracked objects:", data.tracked_objects);
      console.log("Frame status:", data.frame_status);
      console.log(
        "Valid detections:",
        data.tracked_objects?.filter(
          (obj) => obj.is_valid || obj.status === "confirmed"
        )
      );

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

    // Calculate total price whenever confirmedObjects changes
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
    const processingCount = processingItems.size;
    const confirmedInFrame = trackedObjects.filter(
      (obj) => obj.status === "confirmed"
    );
    const undeterminedInFrame = trackedObjects.filter(
      (obj) => obj.status === "undetermined" && obj.is_valid
    );
    const currentTime = Date.now();

    // Items detected but still processing stability
    if (processingCount > 0 && itemsInFrame === 0) {
      return `Detected ${processingCount} item${
        processingCount > 1 ? "s" : ""
      }. Processing stability check, please keep items steady...`;
    }

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

    // Track currently processing items
    const currentlyProcessing = new Set();

    trackedObjects.forEach((obj) => {
      const isProcessingStability = obj.history_length < 15; // MIN_HISTORY_LENGTH from backend
      if (isProcessingStability) {
        currentlyProcessing.add(obj.id);
      }

      // Draw detection boxes for objects being processed
      if (isProcessingStability) {
        const [x1, y1, x2, y2] = obj.bbox;

        // Draw dashed box for processing items
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = "#6366f1"; // Indigo color for processing
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.setLineDash([]); // Reset dash pattern

        // Draw "Processing..." label
        const text = `Processing ${obj.class}...`;
        ctx.font = "16px Arial";
        const textWidth = ctx.measureText(text).width;
        const padding = 4;

        let textX = x1;
        let textY = y1 - 5;
        if (textY < 20) textY = y2 + 20;
        if (textX + textWidth > canvas.width)
          textX = canvas.width - textWidth - padding;

        // Draw label background
        ctx.fillStyle = "#6366f1";
        ctx.beginPath();
        roundRect(
          ctx,
          textX - padding,
          textY - 20,
          textWidth + padding * 2,
          24,
          4
        );
        ctx.fill();

        // Draw text
        ctx.fillStyle = "#ffffff";
        ctx.fillText(text, textX, textY - 4);

        // Draw stability progress bar
        const progressBarHeight = 4;
        const progressBarY = y2 + 5;
        const progressBarWidth = x2 - x1;
        const stabilityProgress = (obj.history_length / 15) * 100; // 15 is MIN_HISTORY_LENGTH

        // Background
        ctx.fillStyle = "rgba(99, 102, 241, 0.3)";
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
        ctx.fillStyle = "rgba(99, 102, 241, 0.9)";
        ctx.beginPath();
        roundRect(
          ctx,
          x1,
          progressBarY,
          (progressBarWidth * stabilityProgress) / 100,
          progressBarHeight,
          2
        );
        ctx.fill();
      }

      // Only draw regular detection boxes for valid or confirmed objects
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

      let textX = x1;
      let textY = y1 - 5;
      if (textY < 20) textY = y2 + 20;
      if (textX + textWidth > canvas.width)
        textX = canvas.width - textWidth - padding;

      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      roundRect(
        ctx,
        textX - padding,
        textY - 20,
        textWidth + padding * 2,
        24,
        4
      );
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, textX, textY - 4);

      // Draw progress bar for undetermined objects
      if (obj.status === "undetermined") {
        const progressBarHeight = 4;
        const progressBarY = y2 + 5;
        const progressBarWidth = x2 - x1;
        const progress = obj.progress || 0;

        // Background (red)
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

        // Progress (green)
        ctx.fillStyle = "rgba(34, 197, 94, 0.9)";
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
    });

    // Update processing items state
    setProcessingItems(currentlyProcessing);
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
    console.log("Proceed to checkout");
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
                      <td className="p-2 text-center">
                        <QuantityAdjuster
                          itemName={itemName}
                          currentQuantity={item.quantity}
                          originalQuantity={originalQuantities[itemName]}
                          unitPrice={item.unit_price}
                          onAdjust={handleQuantityAdjust}
                          onRequestAssistance={handleRequestAssistance}
                          onSpeak={speakInstruction}
                          onReset={resetManualAdjustment}
                          isManuallyAdjusted={Boolean(
                            manualAdjustments[itemName]
                          )}
                        />
                      </td>
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

              {/* Assistance Modal */}
              {showAssistanceModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                  <div className="bg-white p-6 rounded-lg max-w-md">
                    <h3 className="text-lg font-bold mb-4">
                      Assistance Required
                    </h3>
                    <p className="mb-4">{adjustmentMessage}</p>
                    <button
                      onClick={() => setShowAssistanceModal(false)}
                      className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
                    >
                      OK
                    </button>
                  </div>
                </div>
              )}
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
