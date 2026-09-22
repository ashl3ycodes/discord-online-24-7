
## ⚠️ ⦁ Disclaimer
This software interacts with the Discord platform in a way that constitutes automation of a user account, which violates 
<a href="https://discord.com/terms">Discord's Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a>. Improper use may result in account suspension or permanent termination by Discord.
I'm not responsible for any penalties, losses, or damages resulting from the use of this code.
You are solely responsible for how you use this software. Proceed at your own discretion.

---

## ❔ ⦁ What do you need to use it?
- Node.js.
- Git.
- Any Javascript package manager.
- Your Discord Token.
> (IF YOU DON'T KNOW HOW TO GET IT, YOU SHOULDN'T BE USING THIS)

## ✅ ⦁ How to use it?
### Clone the repository and enter the folder.
```shell
git clone https://github.com/ashl3ycodes/Discord-Online-24-7
```

### Install the dependencies from `package.json` using any JavaScript package manager (for example, yarn):
```shell
yarn install
```
### Rename the `.env.example` file to `.env` and fill in the variables:
`DISCORD_OAUTH_TOKEN`:  Your Discord token  
`STATUS`:  Can be one of the following: online, idle, dnd, invisible  

### Custom status
There's nothing to configure: the script mirrors whatever custom status you set in your Discord client (text, emoji and "Clear after"), so it stays visible after you close Discord. Change it or clear it on any device and the script follows within a second.

### Run the script and anything should be working:
```shell
node index.js
```
