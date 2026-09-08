const express = require("express");
const pool = require("../config/database");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.id,
        e.name,
        e.slug,
        e.description,
        e.price_per_day,
        e.image_url,
        c.name AS category,
        COUNT(eu.id) AS total_units,
        COUNT(eu.id) FILTER (
          WHERE eu.status = 'AVAILABLE'
        ) AS available_units
      FROM equipment e
      LEFT JOIN categories c
        ON c.id = e.category_id
      LEFT JOIN equipment_units eu
        ON eu.equipment_id = e.id
      WHERE e.is_active = TRUE
      GROUP BY e.id, c.name
      ORDER BY e.id ASC
    `);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get equipment error:", error);

    res.status(500).json({
      success: false,
      message: "Gagal mengambil data equipment",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        e.id,
        e.name,
        e.slug,
        e.description,
        e.price_per_day,
        e.image_url,
        e.is_active,
        c.id AS category_id,
        c.name AS category,

        COUNT(eu.id) AS total_units,

        COUNT(eu.id) FILTER (
          WHERE eu.status = 'AVAILABLE'
        ) AS available_units

      FROM equipment e

      LEFT JOIN categories c
        ON c.id = e.category_id

      LEFT JOIN equipment_units eu
        ON eu.equipment_id = e.id

      WHERE e.id = $1
        AND e.is_active = TRUE

      GROUP BY
        e.id,
        c.id,
        c.name
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Equipment tidak ditemukan",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Get equipment detail error:", error);

    res.status(500).json({
      success: false,
      message: "Gagal mengambil detail equipment",
    });
  }
});

router.get("/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: "start_date dan end_date wajib diisi",
      });
    }

    if (start_date > end_date) {
      return res.status(400).json({
        success: false,
        message: "Tanggal selesai tidak boleh sebelum tanggal mulai",
      });
    }

    // Hitung seluruh unit fisik yang aktif / bisa disewa
    const unitResult = await pool.query(
      `
            SELECT COUNT(*)::int AS total_units
            FROM equipment_units
            WHERE equipment_id = $1
              AND status != 'MAINTENANCE'
            `,
      [id]
    );

    const totalUnits = unitResult.rows[0]?.total_units || 0;

    /*
     * Cari jumlah unit yang sudah terbooking
     * pada periode tanggal yang bertabrakan.
     *
     * overlap:
     * booking.start_date <= requested_end
     * AND booking.end_date >= requested_start
     */
    const bookedResult = await pool.query(
      `
            SELECT
                COALESCE(SUM(bi.quantity), 0)::int AS booked_units
            FROM booking_items bi
            INNER JOIN bookings b
                ON b.id = bi.booking_id
            WHERE bi.equipment_id = $1
              AND b.start_date <= $3::date
              AND b.end_date >= $2::date
              AND b.rental_status NOT IN (
                  'CANCELLED',
                  'COMPLETED'
              )
            `,
      [id, start_date, end_date]
    );

    const bookedUnits =
      bookedResult.rows[0]?.booked_units || 0;

    const availableUnits = Math.max(
      totalUnits - bookedUnits,
      0
    );

    res.json({
      success: true,
      data: {
        equipment_id: Number(id),
        start_date,
        end_date,
        total_units: totalUnits,
        booked_units: bookedUnits,
        available_units: availableUnits,
        available: availableUnits > 0,
      },
    });
  } catch (error) {
    console.error(
      "Check equipment availability error:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Gagal mengecek ketersediaan equipment",
    });
  }
});
module.exports = router;