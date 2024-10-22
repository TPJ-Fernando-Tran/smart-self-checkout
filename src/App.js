import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";

const LiveDetection = () => {
  const canvasRef = useRef(null);
  const [fps, setFps] = useState(0);
  const [confirmedObjects, setConfirmedObjects] = useState({});
  const [undeterminedObjects, setUndeterminedObjects] = useState([]);
  const [instruction, setInstruction] = useState("");
  const [totalPrice, setTotalPrice] = useState(0);
  const lastInstructionTime = useRef(0);
  let frameCount = 0;
  let lastTime = Date.now();

  useEffect(() => {
    const BACKEND_URL =
      process.env.NEXT_PUBLIC_BACKEND_URL || "http://192.168.137.154:5000";
    const socket = io(BACKEND_URL, {
      secure: true,
      rejectUnauthorized: false,
      transport: ["websocket"],
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
      setConfirmedObjects(data.confirmed_objects);
      setUndeterminedObjects(data.undetermined_objects);
    });

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    const newInstruction = getContextualInstructions();
    if (newInstruction !== instruction) {
      setInstruction(newInstruction);
      speakInstruction(newInstruction);
    }

    // Calculate total price
    const total = Object.values(confirmedObjects).reduce(
      (sum, item) => sum + item.quantity * item.unit_price,
      0
    );
    setTotalPrice(total);

    //   // Repeat instruction for undetermined items
    //   const currentTime = Date.now();
    //   if (
    //     undeterminedObjects.length > 0 &&
    //     currentTime - lastInstructionTime.current > 10000
    //   ) {
    //     speakInstruction(
    //       "Please reposition the yellow-boxed items for better detection."
    //     );
    //     lastInstructionTime.current = currentTime;
    //   }
  }, [confirmedObjects, undeterminedObjects]);

  const drawDetections = (img, trackedObjects) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    trackedObjects.forEach((obj) => {
      const [x1, y1, x2, y2] = obj.bbox;
      const color = obj.status === "confirmed" ? "green" : "yellow";

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      // Add background to text
      ctx.fillStyle = color;
      const text = `ID:${obj.id} ${obj.class} ${(obj.confidence * 100).toFixed(
        1
      )}% ${obj.status}`;
      const textWidth = ctx.measureText(text).width;

      // Adjust text position to ensure it's within the canvas
      let textX = x1;
      let textY = y1 - 5;
      if (textY < 20) textY = y2 + 20; // Move text below if too close to top
      if (textX + textWidth > canvas.width)
        textX = canvas.width - textWidth - 5; // Adjust if too close to right edge

      ctx.fillRect(textX, textY - 15, textWidth + 4, 20);

      // Draw text
      ctx.fillStyle = "black";
      ctx.font = "16px Arial";
      ctx.fillText(text, textX + 2, textY);

      // Draw progress bar for undetermined objects
      if (obj.status === "undetermined") {
        const progressBarHeight = 5;
        const progressBarY = y2 + 5;

        ctx.fillStyle = "rgba(255, 0, 0, 0.5)"; // Semi-transparent red
        ctx.fillRect(x1, progressBarY, x2 - x1, progressBarHeight);

        ctx.fillStyle = "rgba(0, 255, 0, 0.7)"; // Semi-transparent green
        ctx.fillRect(
          x1,
          progressBarY,
          (x2 - x1) * (obj.progress / 100),
          progressBarHeight
        );
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

  const getContextualInstructions = () => {
    const confirmedCount = Object.keys(confirmedObjects).length;
    const totalCount = confirmedCount + undeterminedObjects.length;

    if (confirmedCount === 0 && undeterminedObjects.length === 0) {
      return "Please place items in the scanning area.";
    } else if (
      undeterminedObjects.length > 0 &&
      totalCount >= 2 &&
      confirmedCount >= totalCount / 2
    ) {
      return "Please put the confirmed items in the bagging area first and reposition the yellow-boxed items.";
    } else if (undeterminedObjects.length > 0) {
      return "Please reposition the yellow-boxed items for better detection.";
    } else {
      return "All items confirmed. You can add more items or proceed to checkout.";
    }
  };

  const speakInstruction = (text) => {
    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      speechSynthesis.speak(utterance);
    }
  };

  const handleCheckout = () => {
    // Implement checkout logic here
    console.log("Proceeding to checkout");
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
              <AnimatePresence>
                {Object.entries(confirmedObjects).map(([itemName, item]) => (
                  <motion.tr
                    key={itemName}
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.5 }}
                    className="border-b"
                  >
                    <td className="p-2">
                      <img
                        src={`${BACKEND_URL}/Assets/${item.image_path
                          .split("/")
                          .pop()}`}
                        alt={itemName}
                        className="w-16 h-16 object-cover"
                      />
                    </td>
                    <td className="p-2">{itemName}</td>
                    <td className="p-2">{item.quantity}</td>
                    <td className="p-2">
                      ${item.unit_price?.toFixed(2) || "N/A"}
                    </td>
                    <td className="p-2">
                      ${(item.quantity * item.unit_price).toFixed(2)}
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </table>
          </div>
          <div className="mt-4 text-xl font-bold">
            Total: ${totalPrice.toFixed(2)}
          </div>
          <button
            onClick={handleCheckout}
            disabled={undeterminedObjects.length > 0}
            className={`mt-4 p-2 text-white font-bold rounded ${
              undeterminedObjects.length > 0
                ? "bg-gray-400 cursor-not-allowed"
                : "bg-blue-500 hover:bg-blue-700"
            }`}
          >
            Proceed to Checkout
          </button>
        </div>
      </div>
    </div>
  );
};

export default LiveDetection;
