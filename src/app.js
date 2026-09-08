const express = require("express");
const cors = require("cors");
require("dotenv").config();
const path = require("path");
const pool = require("./config/database");
const equipmentRoutes = require("./routes/equipment.routes");
const bookingRoutes =
    require("./routes/booking.routes");
const paymentRoutes =
    require("./routes/payment.routes");
const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/equipment", equipmentRoutes);
app.use("/api/booking", bookingRoutes);
app.use(
    "/api/payments",
    paymentRoutes
);
app.use(
    "/uploads",
    express.static(
        path.join(__dirname, "../uploads")
    )
);
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "KANCHA Rental API is running",
    });
});

app.get("/api/test-db", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT NOW() AS current_time"
        );

        res.json({
            success: true,
            message: "Database connected",
            databaseTime: result.rows[0].current_time,
        });
    } catch (error) {
        console.error("Database error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed",
        });
    }
});

const PORT = process.env.PORT || 9090;

app.listen(PORT, () => {
    console.log(`KANCHA API running on port ${PORT}`);
});