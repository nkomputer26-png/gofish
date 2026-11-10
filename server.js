const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];

let players = [];
let deck = [];
let hands = {};
let books = {};
let currentTurn = 0;
let gameStarted = false;

function createDeck() {
    let d = [];
    for (let r of RANKS) {
        for (let s of SUITS) {
            d.push({ rank: r, suit: s });
        }
    }
    return d.sort(() => Math.random() - 0.5);
}

function checkBooks(socketId) {
    let hand = hands[socketId];
    let counts = {};
    hand.forEach(c => counts[c.rank] = (counts[c.rank] || 0) + 1);
    
    for (let rank in counts) {
        if (counts[rank] === 4) {
            hands[socketId] = hand.filter(c => c.rank !== rank);
            books[socketId].push(rank);
            io.emit('chat', `Игрок собрал квартет [${rank}]!`);
        }
    }
}

function sendGameState() {
    if (players.length < 2) return;
    players.forEach((id, idx) => {
        const oppId = players[1 - idx];
        io.to(id).emit('state', {
            yourHand: hands[id] || [],
            oppCardCount: hands[oppId] ? hands[oppId].length : 0,
            yourBooks: books[id] || [],
            oppBooks: books[oppId] || [],
            deckCount: deck.length,
            isYourTurn: idx === currentTurn
        });
    });
}

io.on('connection', (socket) => {
    if (players.length < 2) {
        players.push(socket.id);
        hands[socket.id] = [];
        books[socket.id] = [];
        socket.emit('chat', `Вы подключились как Игрок ${players.length}`);
    } else {
        socket.emit('chat', 'Комната уже заполнена!');
        return;
    }

    if (players.length === 2 && !gameStarted) {
        gameStarted = true;
        deck = createDeck();
        players.forEach(p => {
            hands[p] = deck.splice(0, 7);
            books[p] = [];
            checkBooks(p);
        });
        currentTurn = 0;
        io.emit('chat', 'Игра началась! Ход первого игрока.');
        sendGameState();
    }

    socket.on('askCard', (rank) => {
        let playerIdx = players.indexOf(socket.id);
        if (playerIdx !== currentTurn) return;

        let opponentId = players[1 - playerIdx];
        let stolen = hands[opponentId].filter(c => c.rank === rank);

        if (stolen.length > 0) {
            hands[opponentId] = hands[opponentId].filter(c => c.rank !== rank);
            hands[socket.id].push(...stolen);
            checkBooks(socket.id);
            io.emit('chat', `Успешно! Забрано карт: ${stolen.length} шт. достоинства [${rank}]. Ход продолжается!`);
            sendGameState();
        } else {
            io.emit('goFish', `Рыбалка! Карт [${rank}] у соперника нет.`);
            if (deck.length > 0) {
                let drawn = deck.pop();
                hands[socket.id].push(drawn);
                checkBooks(socket.id);
                if (drawn.rank === rank) {
                    io.emit('chat', `Повезло! Вытянута нужная карта [${rank}]. Ходите снова.`);
                } else {
                    currentTurn = 1 - currentTurn;
                }
            } else {
                currentTurn = 1 - currentTurn;
            }
            sendGameState();
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(id => id !== socket.id);
        gameStarted = false;
        io.emit('chat', 'Игрок отключился. Игра сброшена.');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
