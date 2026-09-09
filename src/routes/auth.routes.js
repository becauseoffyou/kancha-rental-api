const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const pool = require("../config/database");

const router = express.Router();

const JWT_SECRET =
    process.env.JWT_SECRET || "kancha-dev-secret";

// ==============================
// REGISTER
// ==============================
router.post("/register", async (req, res) => {
    try {
        const {
            name,
            email,
            phone,
            password,
        } = req.body;

        if (
            !name ||
            !email ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Nama, email, dan password wajib diisi",
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message:
                    "Password minimal 6 karakter",
            });
        }

        const normalizedEmail =
            email.trim().toLowerCase();

        const existingUser =
            await pool.query(
                `
                SELECT id
                FROM users
                WHERE email = $1
                LIMIT 1
                `,
                [normalizedEmail]
            );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message:
                    "Email sudah terdaftar",
            });
        }

        const passwordHash =
            await bcrypt.hash(
                password,
                10
            );

        const result =
            await pool.query(
                `
                INSERT INTO users (
                    name,
                    email,
                    phone,
                    password_hash,
                    auth_provider,
                    verification_status
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    'LOCAL',
                    'UNVERIFIED'
                )
                RETURNING
                    id,
                    name,
                    email,
                    phone,
                    auth_provider,
                    verification_status,
                    created_at
                `,
                [
                    name.trim(),
                    normalizedEmail,
                    phone?.trim() || null,
                    passwordHash,
                ]
            );

        const user =
            result.rows[0];

        const token =
            jwt.sign(
                {
                    userId: user.id,
                    email: user.email,
                },
                JWT_SECRET,
                {
                    expiresIn: "7d",
                }
            );

        return res.status(201).json({
            success: true,
            message:
                "Registrasi berhasil",
            data: {
                token,
                user,
            },
        });
    } catch (error) {
        console.error(
            "Register error:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Gagal melakukan registrasi",
        });
    }
});

// ==============================
// LOGIN
// ==============================
router.post("/login", async (req, res) => {
    try {
        const {
            email,
            password,
        } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message:
                    "Email dan password wajib diisi",
            });
        }

        const normalizedEmail =
            email.trim().toLowerCase();

        const result =
            await pool.query(
                `
                SELECT
                    id,
                    name,
                    email,
                    phone,
                    password_hash,
                    auth_provider,
                    verification_status,
                    created_at
                FROM users
                WHERE email = $1
                LIMIT 1
                `,
                [normalizedEmail]
            );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message:
                    "Email atau password salah",
            });
        }

        const user =
            result.rows[0];

        if (!user.password_hash) {
            return res.status(401).json({
                success: false,
                message:
                    "Akun ini tidak menggunakan login password",
            });
        }

        const validPassword =
            await bcrypt.compare(
                password,
                user.password_hash
            );

        if (!validPassword) {
            return res.status(401).json({
                success: false,
                message:
                    "Email atau password salah",
            });
        }

        const token =
            jwt.sign(
                {
                    userId: user.id,
                    email: user.email,
                },
                JWT_SECRET,
                {
                    expiresIn: "7d",
                }
            );

        delete user.password_hash;

        return res.json({
            success: true,
            message:
                "Login berhasil",
            data: {
                token,
                user,
            },
        });
    } catch (error) {
        console.error(
            "Login error:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Gagal melakukan login",
        });
    }
});

module.exports = router;